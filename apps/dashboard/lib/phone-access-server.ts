import type { NetworkInterfaceInfo } from "node:os";

type NetworkInterfaceMap = NodeJS.Dict<NetworkInterfaceInfo[]>;

export function isPrivateIpv4(address: string): boolean {
  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
    return false;
  }
  const [first, second] = parts as [number, number, number, number];
  return first === 10
    || (first === 172 && second >= 16 && second <= 31)
    || (first === 192 && second === 168)
    || (first === 100 && second >= 64 && second <= 127);
}

export function privateAddresses(interfaces: NetworkInterfaceMap): string[] {
  const addresses: Array<{ address: string; name: string; priority: number }> = [];
  for (const [name, entries] of Object.entries(interfaces)) {
    for (const entry of entries || []) {
      if (entry.family !== "IPv4" || entry.internal || !isPrivateIpv4(entry.address)) continue;
      addresses.push({
        address: entry.address,
        name,
        priority: /^(en0|wi-?fi|wlan)/i.test(name) ? 0 : 1
      });
    }
  }
  return addresses
    .sort((left, right) => left.priority - right.priority || left.name.localeCompare(right.name))
    .map((entry) => entry.address)
    .filter((address, index, all) => all.indexOf(address) === index);
}

export function buildPhoneAccessUrl(
  interfaces: NetworkInterfaceMap,
  portValue: string,
  token: string
): string | null {
  const port = Number.parseInt(portValue, 10);
  const address = privateAddresses(interfaces)[0] || "";
  if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[A-Za-z0-9_-]{43}$/.test(token) || !address) {
    return null;
  }
  return `http://${address}:${port}/connect/${token}`;
}

export function securePhoneAccessUrl(value: string, token: string): string | null {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  try {
    const url = new URL(value);
    const expectedPath = `/connect/${token}`;
    if (
      url.protocol !== "https:"
      || !url.hostname.toLowerCase().endsWith(".ts.net")
      || url.pathname !== expectedPath
      || url.username
      || url.password
      || url.search
      || url.hash
    ) {
      return null;
    }
    return url.toString();
  } catch {
    return null;
  }
}
