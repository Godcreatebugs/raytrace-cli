"""Dedicated VM firewall: agent egress cannot reach private networks or VM services."""
import os
import subprocess
from pathlib import Path

# Lima's user-mode network provides DNS at this address, and the Mac's model
# bridge behind it.
LIMA_HOST = '192.168.5.2'
# Elsewhere the sandbox manager reaches this host over SSH and listens on the
# sandbox network's own gateway (a reverse tunnel, see control_api.py)...
GATEWAY = '172.30.60.1'
# What sandboxes read as /etc/resolv.conf: the host's own forwarder (dns_forwarder.py) on
# their gateway, which writes down each lookup and sends it on to UPSTREAM.
RESOLV = Path('/etc/raytace/resolv.conf')
UPSTREAM = Path('/etc/raytace/upstream-dns')
# Where a sandbox may not connect: private, link-local and multicast ranges,
# and with them the VM's services and the cloud metadata server. engine.py
# reads this list to call a connection there refused, whatever the call returned.
REJECTED = ['0.0.0.0/8', '10.0.0.0/8', '100.64.0.0/10', '127.0.0.0/8',
            '169.254.0.0/16', '172.16.0.0/12', '192.168.0.0/16', '224.0.0.0/4']
# The manager's bridge as sandboxes address it; projects.py puts it in their env.
BRIDGE = Path('/etc/raytace/bridge')


def run(*args):
    subprocess.run(args, check=True)


def resolver():
    """The resolver the host's forwarder sends sandboxes' lookups on to."""
    # RAYTACE_DNS is set once at setup (sudo drops it on later runs from
    # run.py), so the address already written wins after that. A cloud VM
    # sets a public resolver: its own DNS server is the metadata server
    # (169.254.169.254 on GCP), which the rules below must keep blocked.
    if os.environ.get('RAYTACE_DNS'):
        return os.environ['RAYTACE_DNS']
    if UPSTREAM.exists():
        return UPSTREAM.read_text().split()[0]
    # A host set up before the forwarder: its sandboxes asked the resolver themselves.
    if RESOLV.exists() and RESOLV.read_text().split()[1] != GATEWAY:
        return RESOLV.read_text().split()[1]
    return LIMA_HOST


def private_bridge():
    """...or, hosted, the control plane's bridge at its private address:port
    (RAYTACE_BRIDGE, set once at setup like RAYTACE_DNS, then kept in BRIDGE)."""
    if os.environ.get('RAYTACE_BRIDGE'):
        return os.environ['RAYTACE_BRIDGE']
    written = BRIDGE.read_text().strip().removeprefix('http://') if BRIDGE.exists() else ''
    return written if written and not written.startswith((LIMA_HOST + ':', GATEWAY + ':')) else None


if __name__ == '__main__':
    dns = resolver()
    UPSTREAM.write_text(dns + '\n')
    RESOLV.write_text(f'nameserver {GATEWAY}\n')
    if subprocess.run(['docker', 'network', 'inspect', 'raytace-egress'], stdout=subprocess.DEVNULL,
                      stderr=subprocess.DEVNULL).returncode:
        run('docker', 'network', 'create', '--driver=bridge', '--subnet=172.30.60.0/24',
            '--opt=com.docker.network.bridge.name=br-raytace', 'raytace-egress')
    def rule(chain, *args):
        if subprocess.run(['iptables', '-C', chain, *args], stderr=subprocess.DEVNULL).returncode:
            run('iptables', '-I', chain, '1', *args)
    for destination in REJECTED:
        rule('DOCKER-USER', '-i', 'br-raytace', '-d', destination, '-j', 'REJECT')
    rule('INPUT', '-i', 'br-raytace', '-j', 'REJECT')
    # Only DNS is exempted, and only at the host's forwarder on the gateway.
    # The rule that let sandboxes ask the resolver itself is taken away: a
    # lookup that went round the forwarder would be one nobody wrote down.
    for protocol in ['udp', 'tcp']:
        rule('INPUT', '-i', 'br-raytace', '-d', GATEWAY, '-p', protocol, '--dport', '53', '-j', 'ACCEPT')
        former = ['DOCKER-USER', '-i', 'br-raytace', '-d', dns, '-p', protocol, '--dport', '53', '-j', 'ACCEPT']
        if not subprocess.run(['iptables', '-C', *former], stderr=subprocess.DEVNULL).returncode:
            run('iptables', '-D', *former)
    # Only the authenticated model and transcript bridge. Its management API rejects this Host.
    bridge = private_bridge()
    if bridge:
        # Above the private-range rejects: this one address and port, nothing else on the VPC.
        address, port = bridge.rsplit(':', 1)
        rule('DOCKER-USER', '-i', 'br-raytace', '-d', address, '-p', 'tcp', '--dport', port, '-j', 'ACCEPT')
        BRIDGE.write_text(f'http://{bridge}\n')
    elif dns == LIMA_HOST:
        rule('DOCKER-USER', '-i', 'br-raytace', '-d', LIMA_HOST,
             '-p', 'tcp', '--dport', '8799', '-j', 'ACCEPT')
        BRIDGE.write_text(f'http://{LIMA_HOST}:8799\n')
    else:
        rule('INPUT', '-i', 'br-raytace', '-d', GATEWAY,
             '-p', 'tcp', '--dport', '8799', '-j', 'ACCEPT')
        BRIDGE.write_text(f'http://{GATEWAY}:8799\n')
