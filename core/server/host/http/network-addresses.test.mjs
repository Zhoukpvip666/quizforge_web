import test from 'node:test';
import assert from 'node:assert/strict';
import {recommendedAddresses} from './network-addresses.js';

const entry=(interfaceName,address,internal=false)=>({interfaceName,address,internal});
test('recommended URLs use the connected physical route and omit VPN, VM and inactive adapters',()=>{
 const entries=[entry('VMnet8','192.168.1.1'),entry('Mihomo','fdfe:dcba::1'),entry('Ethernet','10.0.0.2'),entry('WLAN','192.168.153.166'),entry('WLAN','2408:1234::2'),entry('WLAN','2408:1234::3'),entry('WLAN','fe80::1%4'),entry('Loopback','127.0.0.1',true)];
 const metadata={adapters:[{name:'VMnet8',up:true,physical:false,index:2},{name:'Mihomo',up:true,physical:false,index:3},{name:'Ethernet',up:false,physical:true,index:4},{name:'WLAN',up:true,physical:true,index:5}],routes:[{index:3,metric:0},{index:5,metric:10}]};
 assert.deepEqual(recommendedAddresses(entries,metadata).map(value=>value.address),['192.168.153.166','2408:1234::2']);
});
test('two connected physical adapters prefer the active default route, including renamed adapters',()=>{
 const metadata={adapters:[{name:'自定义网卡',up:true,physical:true,index:1},{name:'WLAN',up:true,physical:true,index:2}],routes:[{index:1,metric:1},{index:2,metric:20}]};
 assert.equal(recommendedAddresses([entry('WLAN','192.168.1.2'),entry('自定义网卡','10.0.0.2')],metadata)[0].address,'10.0.0.2');
});
test('metadata fallback still excludes common virtual links without changing their server permissions',()=>{
 assert.deepEqual(recommendedAddresses([entry('vEthernet (WSL)','172.20.1.1'),entry('Tailscale','100.64.1.2'),entry('WLAN','192.168.1.2')]).map(value=>value.address),['192.168.1.2']);
 assert.deepEqual(recommendedAddresses([entry('Mihomo','fdfe:dcba::1')]),[]);
});
