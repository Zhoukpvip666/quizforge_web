package io.quizforge.web;

import java.net.InetAddress;
import org.junit.jupiter.api.Test;
import static org.junit.jupiter.api.Assertions.*;

class NetworkAddressesTest {
    @Test void equivalentIpv6LiteralsCompareWithoutResolvingDomains() {
        assertTrue(NetworkAddresses.sameHost("[2001:db8::a]", "2001:0DB8:0:0:0:0:0:a"));
        assertFalse(NetworkAddresses.sameHost("[2001:db8::a]", "[2001:db8::b]"));
        assertTrue(NetworkAddresses.sameHost("QUIZ.Example.test", "quiz.example.test"));
        assertNull(NetworkAddresses.hostKey("fe80::1%25eth0"));
        assertFalse(NetworkAddresses.sameHost(null, null));
        assertEquals("http://[2001:db8::a]:8788/", NetworkAddresses.url("2001:db8::a", 8788));
        assertEquals("http://192.168.1.2:8788/", NetworkAddresses.url("192.168.1.2", 8788));
    }

    @Test void lanClassificationAndAddressListExcludeUnusableAddresses() throws Exception {
        assertTrue(QuizForgeServer.localNetworkPeer(InetAddress.getByName("fd12:3456::1")));
        assertTrue(QuizForgeServer.localNetworkPeer(InetAddress.getByName("fc00::1")));
        assertFalse(QuizForgeServer.localNetworkPeer(InetAddress.getByName("2001:db8::1")));
        assertTrue(NetworkAddresses.globalIpv6(InetAddress.getByName("2001:db8::1")));
        assertFalse(NetworkAddresses.globalIpv6(InetAddress.getByName("fd12::1")));
        for (String address : new String[]{"::", "::1", "fe80::1", "ff02::1", "127.0.0.1", "169.254.1.2"})
            assertFalse(NetworkAddresses.usable(InetAddress.getByName(address)), address);
        assertTrue(NetworkAddresses.usable(InetAddress.getByName("fd12::1")));
    }

    @Test void globalLanPeerMustMatchActualLocalSubnet() throws Exception {
        var subnet = new NetworkAddresses.Subnet(InetAddress.getByName("2001:db8:12:34::1"), (short) 64);
        assertTrue(subnet.contains(InetAddress.getByName("2001:db8:12:34::ffff")));
        assertFalse(subnet.contains(InetAddress.getByName("2001:db8:12:35::1")));
        assertFalse(subnet.contains(InetAddress.getByName("192.168.1.2")));
        assertFalse(new NetworkAddresses.Subnet(subnet.address(), (short) 32).contains(subnet.address()));
        var narrow = new NetworkAddresses.Subnet(subnet.address(), (short) 127);
        assertTrue(narrow.contains(InetAddress.getByName("2001:db8:12:34::")));
        assertFalse(narrow.contains(InetAddress.getByName("2001:db8:12:34::2")));
    }

    @Test void publicAddressValidationRejectsLocalAndScopedIpv6() {
        assertEquals("http://[2001:db8::a]:8788/", NetworkSettings.normalizePublicUrl("http://[2001:db8::a]:8788/"));
        for (String host : new String[]{"::", "::1", "0:0:0:0:0:0:0:1", "::ffff:127.0.0.1", "::ffff:0.0.0.0", "fe80::1", "fe80::1%25eth0", "ff02::1"})
            assertThrows(ApiException.class, () -> NetworkSettings.normalizePublicUrl("http://[" + host + "]:8788/"), host);
    }
}
