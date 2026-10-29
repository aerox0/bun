/**
 * All tests in this file run in both Bun and Node.js: `bun test` runs them
 * here, and the last test runs this same file under Node.js.
 *
 * A handle prints the address that getsockname(), getpeername() or recvmsg()
 * returned with AddressToJS(). A link-local address (fe80::/10) with a scope
 * id gets `%` and its interface: the name of the interface, or its index on
 * Windows. No other address gets a zone, whatever its scope id is. Without
 * the zone such an address names no peer, so connect() refuses it.
 * https://github.com/nodejs/node/blob/v26.3.0/src/tcp_wrap.cc#L520-L596
 *
 * address() and remoteAddress() of a dgram socket ask the kernel on every
 * call and return a new object:
 * https://github.com/nodejs/node/blob/v26.3.0/lib/dgram.js#L815-L840
 */
import assert from "node:assert";
import dgram from "node:dgram";
import { once } from "node:events";
import http from "node:http";
import net from "node:net";
import os from "node:os";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

function findLinkLocal() {
  for (const [name, addresses] of Object.entries(os.networkInterfaces())) {
    for (const { address, family, scopeid } of addresses ?? []) {
      if (family === "IPv6" && address.startsWith("fe80:")) {
        const zone = process.platform === "win32" ? String(scopeid) : name;
        return { address, zone, scoped: `${address}%${zone}` };
      }
    }
  }
}

function canBind(type: "udp4" | "udp6", address: string) {
  return new Promise<boolean>(resolve => {
    const probe = dgram.createSocket(type);
    probe.once("error", () => probe.close(() => resolve(false)));
    probe.bind(0, address, () => probe.close(() => resolve(true)));
  });
}

// CI hosts can be without a link-local address, and without IPv6 at all.
const found = findLinkLocal();
const linkLocal = found && (await canBind("udp6", found.scoped)) ? found : undefined;
const hasIPv6Loopback = await canBind("udp6", "::1");

async function bound(type: "udp4" | "udp6", address: string) {
  const socket = dgram.createSocket(type);
  const listening = once(socket, "listening");
  socket.bind(0, address);
  await listening;
  return socket;
}

function connect(socket: dgram.Socket, port: number, address: string) {
  return new Promise<void>((resolve, reject) => {
    socket.once("error", reject);
    socket.connect(port, address, (err?: Error | null) => {
      socket.off("error", reject);
      if (err) reject(err);
      else resolve();
    });
  });
}

describe("node:dgram", () => {
  test("address() of a socket on a link-local address has the zone", { skip: !linkLocal }, async () => {
    const socket = await bound("udp6", linkLocal!.scoped);
    try {
      const { address, family, port } = socket.address();
      assert.deepStrictEqual({ address, family }, { address: linkLocal!.scoped, family: "IPv6" });
      assert.ok(port > 0);
    } finally {
      socket.close();
    }
  });

  test("the address that address() returns connects, and every end has the zone", { skip: !linkLocal }, async () => {
    const server = await bound("udp6", linkLocal!.scoped);
    const client = dgram.createSocket("udp6");
    try {
      const { address, port } = server.address();
      await connect(client, port, address);
      assert.deepStrictEqual(client.remoteAddress(), { address: linkLocal!.scoped, family: "IPv6", port });
      // The kernel took the source address for that peer, and with it the interface.
      assert.deepStrictEqual(client.address(), {
        address: linkLocal!.scoped,
        family: "IPv6",
        port: client.address().port,
      });

      const message = once(server, "message");
      client.send("hello");
      const [, rinfo] = await message;
      assert.deepStrictEqual(
        { address: rinfo.address, family: rinfo.family, port: rinfo.port },
        { address: linkLocal!.scoped, family: "IPv6", port: client.address().port },
      );
    } finally {
      client.close();
      server.close();
    }
  });

  // The kernel reports the scope id of a link-local multicast peer too. Only fe80::/10 gets a zone.
  test("a multicast peer with a scope id has no zone", { skip: !linkLocal }, async () => {
    const socket = dgram.createSocket("udp6");
    try {
      await connect(socket, 4321, `ff02::1%${linkLocal!.zone}`);
      assert.deepStrictEqual(socket.remoteAddress(), { address: "ff02::1", family: "IPv6", port: 4321 });
    } finally {
      socket.close();
    }
  });

  for (const [type, address, family] of [
    ["udp4", "127.0.0.1", "IPv4"],
    ["udp6", "::1", "IPv6"],
  ] as const) {
    const skip = type === "udp6" && !hasIPv6Loopback;

    test(`${type}: address() and remoteAddress() of a socket on ${address}`, { skip }, async () => {
      const server = await bound(type, address);
      const client = await bound(type, address);
      try {
        const port = server.address().port;
        assert.deepStrictEqual(server.address(), { address, family, port });
        await connect(client, port, address);
        assert.deepStrictEqual(client.remoteAddress(), { address, family, port });
        assert.deepStrictEqual(client.address(), { address, family, port: client.address().port });
      } finally {
        client.close();
        server.close();
      }
    });

    test(`${type}: address() and remoteAddress() return a new object on every call`, { skip }, async () => {
      const server = await bound(type, address);
      const client = await bound(type, address);
      try {
        await connect(client, server.address().port, address);
        const remote = client.remoteAddress();
        assert.notStrictEqual(client.remoteAddress(), remote);
        assert.deepStrictEqual(client.remoteAddress(), remote);
        const local = client.address();
        assert.notStrictEqual(client.address(), local);
        assert.deepStrictEqual(client.address(), local);

        // What the caller does to a result does not reach the next one.
        (remote as { address: string }).address = "changed";
        assert.strictEqual(client.remoteAddress().address, address);
      } finally {
        client.close();
        server.close();
      }
    });
  }
});

describe("node:net", () => {
  const addressesOf = (socket: net.Socket) => ({
    remoteAddress: socket.remoteAddress,
    remoteFamily: socket.remoteFamily,
    remotePort: socket.remotePort,
    localAddress: socket.localAddress,
    localPort: socket.localPort,
    address: socket.address(),
  });

  async function connected(host: string) {
    const server = net.createServer();
    server.listen(0, host);
    await once(server, "listening");
    const listening = server.address() as net.AddressInfo;
    const connection = once(server, "connection") as Promise<[net.Socket]>;
    // The address that the server printed connects to it.
    const client = net.connect(listening.port, listening.address);
    await once(client, "connect");
    const [accepted] = await connection;
    return {
      listening,
      client,
      accepted,
      close() {
        client.destroy();
        accepted.destroy();
        server.close();
      },
    };
  }

  for (const [name, host, family, skip] of [
    ["a link-local address, with the zone", linkLocal?.scoped, "IPv6", !linkLocal],
    ["127.0.0.1", "127.0.0.1", "IPv4", false],
    ["::1", "::1", "IPv6", !hasIPv6Loopback],
  ] as const) {
    test(`every address of a connection over ${name}`, { skip }, async () => {
      const { listening, client, accepted, close } = await connected(host!);
      try {
        const port = listening.port;
        const clientPort = client.localPort!;
        assert.deepStrictEqual(
          { listening, client: addressesOf(client), accepted: addressesOf(accepted) },
          {
            listening: { address: host, family, port },
            client: {
              remoteAddress: host,
              remoteFamily: family,
              remotePort: port,
              localAddress: host,
              localPort: clientPort,
              address: { address: host, family, port: clientPort },
            },
            accepted: {
              remoteAddress: host,
              remoteFamily: family,
              remotePort: clientPort,
              localAddress: host,
              localPort: port,
              address: { address: host, family, port },
            },
          },
        );
      } finally {
        close();
      }
    });
  }
});

describe("node:http", () => {
  for (const [name, host, family, skip] of [
    ["a link-local address, with the zone", linkLocal?.scoped, "IPv6", !linkLocal],
    ["127.0.0.1", "127.0.0.1", "IPv4", false],
  ] as const) {
    test(`server.address() and req.socket of a server on ${name}`, { skip }, async () => {
      const request = Promise.withResolvers<object>();
      const server = http.createServer((req, res) => {
        const { remoteAddress, remoteFamily, remotePort, localAddress, localPort } = req.socket;
        request.resolve({ remoteAddress, remoteFamily, remotePort, localAddress, localPort });
        res.end();
      });
      server.listen(0, host);
      await once(server, "listening");
      try {
        const listening = server.address() as net.AddressInfo;
        // The address that the server printed connects to it.
        const [response] = (await once(
          http.get({ host: listening.address, port: listening.port, agent: false }),
          "response",
        )) as [http.IncomingMessage];
        const clientPort = response.socket.localPort;
        response.resume();
        await once(response, "end");
        assert.deepStrictEqual(
          { listening, request: await request.promise },
          {
            listening: { address: host, family, port: listening.port },
            request: {
              remoteAddress: host,
              remoteFamily: family,
              remotePort: clientPort,
              localAddress: host,
              localPort: listening.port,
            },
          },
        );
      } finally {
        server.close();
      }
    });
  }
});

// Only in Bun: when Node.js runs this file it must not spawn itself again.
if (typeof Bun !== "undefined") {
  const { bunEnv, nodeExeAtLeast } = await import("harness");
  // The expected values above are those of v26.3.0.
  const node = nodeExeAtLeast("26.3.0");

  describe("Node.js compatibility", () => {
    (node ? test : test.skip)("all tests pass in Node.js", async () => {
      // A direct run, not `node --test`: the runner mode forks a second node
      // process per file. node:test still exits non-zero on any failure.
      await using proc = Bun.spawn({
        cmd: [node!, fileURLToPath(import.meta.url)],
        env: bunEnv,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([proc.stdout.text(), proc.stderr.text(), proc.exited]);
      assert.deepStrictEqual({ exitCode, output: exitCode === 0 ? "" : stdout + stderr }, { exitCode: 0, output: "" });
    });
  });
}
