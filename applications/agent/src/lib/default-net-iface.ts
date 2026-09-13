import fs from 'node:fs';

/**
 * Finds the interface carrying the default route (Destination `00000000`
 * in `/proc/net/route`) - i.e. the box's real uplink, e.g. `eth0`.
 *
 * This exists because of a real bug caught during verification on the VPS:
 * summing every interface in `/proc/net/dev` except `lo` picked up Docker's
 * `docker0`/`br-*`/`veth*` interfaces too. Those get created and destroyed
 * every time a container's network attaches/detaches (reproduced live: a
 * Caddy container restart during this same session tore down and recreated
 * its veth pair) - an interface disappearing between two samples makes the
 * summed counter look like it went backwards, which `computeNetRate`
 * correctly treats as a reset and reports `null` for. The fix is to only
 * ever measure the one interface that is actually "network speed" in the
 * sense the brief means (traffic to/from the internet), not internal
 * container-to-container traffic that would be double-counted anyway
 * (each container-to-container packet is both an rx and a tx on some
 * bridge/veth pair).
 */
export function findDefaultRouteInterface(
  routeText = fs.readFileSync('/proc/net/route', 'utf8'),
): string | undefined {
  for (const line of routeText.split('\n').slice(1)) {
    const fields = line.trim().split(/\s+/);
    const iface = fields[0];
    const destination = fields[1];
    if (iface && destination === '00000000') {
      return iface;
    }
  }
  return undefined;
}
