package io.quizforge.web;

import java.io.IOException;
import java.net.Inet6Address;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.util.Locale;

/** Literal address handling; domain comparison never performs DNS lookup. */
final class NetworkAddresses {
    private NetworkAddresses() { }

    static boolean ipv6Available() {
        if (Boolean.getBoolean("java.net.preferIPv4Stack")) return false;
        try (ServerSocket probe = new ServerSocket(0, 1, InetAddress.getByName("::1"))) { return true; }
        catch (IOException unavailable) { return false; }
    }

    static String hostKey(String host) {
        if (host == null) return null;
        String value = host.replace("[", "").replace("]", "").toLowerCase(Locale.ROOT);
        if (value.contains("%")) return null; // Scoped link-local URLs are not browser connection addresses.
        if (!value.contains(":")) return value;
        try { return InetAddress.getByName(value).getHostAddress().toLowerCase(Locale.ROOT); }
        catch (IOException invalid) { return null; }
    }

    static boolean sameHost(String first, String second) {
        String key = hostKey(first);
        return key != null && key.equals(hostKey(second));
    }

    static boolean uniqueLocal(InetAddress address) {
        return address instanceof Inet6Address && (address.getAddress()[0] & 0xfe) == 0xfc;
    }

    static boolean globalIpv6(InetAddress address) {
        return address instanceof Inet6Address && (address.getAddress()[0] & 0xe0) == 0x20;
    }

    static boolean usable(InetAddress address) {
        return !address.isAnyLocalAddress() && !address.isLoopbackAddress() && !address.isLinkLocalAddress() && !address.isMulticastAddress();
    }

    static String url(String host, int port) {
        String literal = host.replace("[", "").replace("]", "");
        return "http://" + (literal.contains(":") ? "[" + literal + "]" : literal) + ":" + port + "/";
    }

    record Subnet(InetAddress address, short prefix) {
        boolean contains(InetAddress peer) {
            // Only an actual local IPv6 subnet qualifies; a broad routing prefix must not open LAN access.
            if (!(peer instanceof Inet6Address) || !(address instanceof Inet6Address) || prefix < 64 || prefix > 128) return false;
            byte[] local = address.getAddress(), remote = peer.getAddress();
            for (int i = 0; i < prefix; i++) {
                int mask = 1 << (7 - i % 8);
                if ((local[i / 8] & mask) != (remote[i / 8] & mask)) return false;
            }
            return true;
        }
    }
}
