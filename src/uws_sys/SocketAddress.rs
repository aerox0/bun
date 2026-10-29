//! The text of a socket address that the kernel returned: from `getsockname()`, `getpeername()` or `recvmsg()`.

use core::ffi::c_int;

use bun_errno::E;

#[cfg(windows)]
pub use bun_windows_sys::ws2_32::sockaddr_storage;
#[cfg(windows)]
use bun_windows_sys::ws2_32::{AF_INET, AF_INET6, sockaddr_in, sockaddr_in6};
#[cfg(not(windows))]
pub use libc::sockaddr_storage;
#[cfg(not(windows))]
use libc::{AF_INET, AF_INET6, sockaddr_in, sockaddr_in6};

/// Node.js reserves `INET6_ADDRSTRLEN + UV_IF_NAMESIZE` (63) bytes for an address and its zone.
const TEXT_CAPACITY: usize = 64;

/// Whether `addr`, which is `AF_INET` or `AF_INET6`, is the latter.
pub fn sockaddr_is_ipv6(addr: &sockaddr_storage) -> bool {
    c_int::from(addr.ss_family) == AF_INET6
}

/// An IP address as text, and its port.
pub struct SocketAddress {
    text: [u8; TEXT_CAPACITY],
    len: u8,
    pub port: u16,
    pub is_ipv6: bool,
}

impl SocketAddress {
    /// `addr` as Node.js prints it ([`AddressToJS`](https://github.com/nodejs/node/blob/v26.3.0/src/tcp_wrap.cc#L520-L596)).
    /// The address is the `inet_ntop()` text. A link-local IPv6 address with a scope id also has `%` and its
    /// interface: the name of the interface, or its index on Windows. `Err` is the errno of the name lookup.
    /// An `addr` that is neither `AF_INET` nor `AF_INET6` has an empty address.
    pub fn from_sockaddr(addr: &sockaddr_storage) -> Result<SocketAddress, E> {
        let (mut address, scope_id) = Self::without_zone(addr);
        if scope_id != 0 {
            address.append_zone(scope_id)?;
        }
        Ok(address)
    }

    /// [`Self::from_sockaddr`] for the sender of a datagram, where nothing can report a failed lookup: an
    /// interface that has no name is printed by index.
    pub fn from_sockaddr_lossy(addr: &sockaddr_storage) -> SocketAddress {
        let (mut address, scope_id) = Self::without_zone(addr);
        if scope_id != 0 && address.append_zone(scope_id).is_err() {
            address.append_zone_index(scope_id);
        }
        address
    }

    /// The address with no zone, and the scope id to print after it: 0 unless the address is link-local
    /// (`IN6_IS_ADDR_LINKLOCAL`). A multicast or loopback address has no zone in Node.js, whatever its scope id.
    fn without_zone(addr: &sockaddr_storage) -> (SocketAddress, u32) {
        let mut address = SocketAddress {
            text: [0; TEXT_CAPACITY],
            len: 0,
            port: 0,
            is_ipv6: false,
        };
        let mut scope_id = 0;
        let len = match c_int::from(addr.ss_family) {
            AF_INET => {
                // SAFETY: the family says that `addr` holds a `sockaddr_in`.
                let v4 = unsafe { &*core::ptr::from_ref(addr).cast::<sockaddr_in>() };
                address.port = u16::from_be(v4.sin_port);
                // SAFETY: `sin_addr` is the `in_addr` that `AF_INET` asks for.
                unsafe {
                    bun_cares_sys::ntop(AF_INET, (&raw const v4.sin_addr).cast(), &mut address.text)
                }
                .map_or(0, <[u8]>::len)
            }
            AF_INET6 => {
                // SAFETY: the family says that `addr` holds a `sockaddr_in6`.
                let v6 = unsafe { &*core::ptr::from_ref(addr).cast::<sockaddr_in6>() };
                address.port = u16::from_be(v6.sin6_port);
                address.is_ipv6 = true;
                let octets = &v6.sin6_addr.s6_addr;
                if octets[0] == 0xfe && octets[1] & 0xc0 == 0x80 {
                    scope_id = v6.sin6_scope_id;
                }
                // SAFETY: `sin6_addr` is the `in6_addr` that `AF_INET6` asks for.
                unsafe {
                    bun_cares_sys::ntop(
                        AF_INET6,
                        (&raw const v6.sin6_addr).cast(),
                        &mut address.text,
                    )
                }
                .map_or(0, <[u8]>::len)
            }
            _ => 0,
        };
        address.len = len as u8;
        (address, scope_id)
    }

    /// Appends `%` and the interface. libuv's `uv_if_indextoiid()` is the name of the interface, and the
    /// index on Windows, where it cannot fail.
    fn append_zone(&mut self, scope_id: u32) -> Result<(), E> {
        #[cfg(not(windows))]
        {
            let mut interface = [0u8; libc::IF_NAMESIZE];
            // SAFETY: `if_indextoname()` writes at most `IF_NAMESIZE` bytes, the NUL included.
            if unsafe { libc::if_indextoname(scope_id, interface.as_mut_ptr().cast()) }.is_null() {
                return Err(bun_errno::last_error());
            }
            self.append(b"%");
            self.append(bun_core::ffi::slice_to_nul(&interface));
        }
        #[cfg(windows)]
        self.append_zone_index(scope_id);
        Ok(())
    }

    fn append_zone_index(&mut self, scope_id: u32) {
        use std::io::Write as _;
        let mut unwritten = &mut self.text[usize::from(self.len)..];
        let capacity = unwritten.len();
        // Only a link-local address gets here. It has at most 39 bytes, so `%` and ten digits fit.
        let _ = write!(unwritten, "%{scope_id}");
        self.len += (capacity - unwritten.len()) as u8;
    }

    fn append(&mut self, bytes: &[u8]) {
        let len = usize::from(self.len);
        self.text[len..len + bytes.len()].copy_from_slice(bytes);
        self.len += bytes.len() as u8;
    }

    pub(crate) fn new(ip: &[u8], port: i32, is_ipv6: bool) -> SocketAddress {
        let mut address = SocketAddress {
            text: [0; TEXT_CAPACITY],
            len: 0,
            port: port as u16,
            is_ipv6,
        };
        address.append(&ip[..ip.len().min(TEXT_CAPACITY)]);
        address
    }

    pub fn ip(&self) -> &[u8] {
        &self.text[..usize::from(self.len)]
    }

    pub fn is_loopback(&self) -> bool {
        let ip = self.ip();
        // IPv4 loopback addresses
        if ip.starts_with(b"127.") {
            return true;
        }
        // IPv6 loopback addresses
        if ip.starts_with(b"::ffff:127.") || ip == b"::1" || ip == b"0:0:0:0:0:0:0:1" {
            return true;
        }
        false
    }
}
