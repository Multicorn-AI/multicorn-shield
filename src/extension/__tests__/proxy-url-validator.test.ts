/**
 * @vitest-environment node
 */

import { describe, it, expect } from "vitest";
import { assertSafeProxyUrl, ProxyUrlValidationError } from "../proxy-url-validator.js";

describe("assertSafeProxyUrl", () => {
  describe("blocked", () => {
    it("rejects metadata link-local IPv4", () => {
      expect(() => {
        assertSafeProxyUrl("http://169.254.169.254/latest/meta-data/");
      }).toThrow(ProxyUrlValidationError);
    });

    it("rejects IPv6 unique local", () => {
      expect(() => {
        assertSafeProxyUrl("http://[fd00::1]/");
      }).toThrow(ProxyUrlValidationError);
    });

    it("rejects IPv4 loopback", () => {
      expect(() => {
        assertSafeProxyUrl("http://127.0.0.1/mcp");
      }).toThrow(ProxyUrlValidationError);
    });

    /* WHATWG URL parses leading-zero octets as octal; host becomes 127.0.0.1. */
    it("rejects octal-encoded loopback (0177.0.0.1)", () => {
      expect(() => {
        assertSafeProxyUrl("http://0177.0.0.1/mcp");
      }).toThrow(ProxyUrlValidationError);
    });

    /* Single-component IPv4 parses as 32-bit; host becomes 127.0.0.1. */
    it("rejects decimal-integer loopback (2130706433)", () => {
      expect(() => {
        assertSafeProxyUrl("http://2130706433/mcp");
      }).toThrow(ProxyUrlValidationError);
    });

    it("rejects localhost", () => {
      expect(() => {
        assertSafeProxyUrl("http://localhost/mcp");
      }).toThrow(ProxyUrlValidationError);
    });

    it("rejects LOCALHOST case-insensitively", () => {
      expect(() => {
        assertSafeProxyUrl("http://LOCALHOST/mcp");
      }).toThrow(ProxyUrlValidationError);
    });

    it("rejects IPv6 loopback", () => {
      expect(() => {
        assertSafeProxyUrl("http://[::1]/mcp");
      }).toThrow(ProxyUrlValidationError);
    });

    it("rejects RFC1918 class A", () => {
      expect(() => {
        assertSafeProxyUrl("http://10.0.0.1/mcp");
      }).toThrow(ProxyUrlValidationError);
    });

    it("rejects RFC1918 class B lower bound", () => {
      expect(() => {
        assertSafeProxyUrl("http://172.16.0.1/mcp");
      }).toThrow(ProxyUrlValidationError);
    });

    it("rejects RFC1918 class B upper bound", () => {
      expect(() => {
        assertSafeProxyUrl("http://172.31.255.255/mcp");
      }).toThrow(ProxyUrlValidationError);
    });

    it("rejects RFC1918 class C", () => {
      expect(() => {
        assertSafeProxyUrl("http://192.168.1.1/mcp");
      }).toThrow(ProxyUrlValidationError);
    });

    it("rejects file scheme", () => {
      expect(() => {
        assertSafeProxyUrl("file:///etc/passwd");
      }).toThrow(ProxyUrlValidationError);
    });

    it("rejects data scheme", () => {
      expect(() => {
        assertSafeProxyUrl("data:text/plain,hello");
      }).toThrow(ProxyUrlValidationError);
    });

    it("rejects ftp scheme", () => {
      expect(() => {
        assertSafeProxyUrl("ftp://internal/");
      }).toThrow(ProxyUrlValidationError);
    });

    it("rejects malformed URL", () => {
      expect(() => {
        assertSafeProxyUrl("not-a-url");
      }).toThrow(ProxyUrlValidationError);
    });

    it("rejects empty string", () => {
      expect(() => {
        assertSafeProxyUrl("");
      }).toThrow(ProxyUrlValidationError);
    });

    it("rejects 0.0.0.0", () => {
      expect(() => {
        assertSafeProxyUrl("http://0.0.0.0/mcp");
      }).toThrow(ProxyUrlValidationError);
    });
  });

  describe("allowed", () => {
    it("allows multicorn proxy https URL", () => {
      expect(() => {
        assertSafeProxyUrl("https://proxy.multicorn.ai/r/t1/mcp");
      }).not.toThrow();
    });

    it("allows example host over http", () => {
      expect(() => {
        assertSafeProxyUrl("http://proxy.example.com/mcp");
      }).not.toThrow();
    });

    it("allows 172.15 (outside RFC1918 172.16-31)", () => {
      expect(() => {
        assertSafeProxyUrl("http://172.15.0.1/mcp");
      }).not.toThrow();
    });

    it("allows 172.32 (outside RFC1918 172.16-31)", () => {
      expect(() => {
        assertSafeProxyUrl("http://172.32.0.1/mcp");
      }).not.toThrow();
    });
  });

  describe("allowPrivateNetworks bypass", () => {
    it("allows 127.0.0.1 when flag is true", () => {
      expect(() => {
        assertSafeProxyUrl("http://127.0.0.1/mcp", { allowPrivateNetworks: true });
      }).not.toThrow();
    });

    it("allows localhost when flag is true", () => {
      expect(() => {
        assertSafeProxyUrl("http://localhost/mcp", { allowPrivateNetworks: true });
      }).not.toThrow();
    });

    it("allows RFC1918 when flag is true", () => {
      expect(() => {
        assertSafeProxyUrl("http://10.0.0.1/mcp", { allowPrivateNetworks: true });
      }).not.toThrow();
    });

    it("allows metadata IP when flag is true", () => {
      expect(() => {
        assertSafeProxyUrl("http://169.254.169.254/latest/meta-data/", {
          allowPrivateNetworks: true,
        });
      }).not.toThrow();
    });
  });

  describe("allowPrivateNetworks does not bypass scheme checks", () => {
    it("still rejects file:// when flag is true", () => {
      expect(() => {
        assertSafeProxyUrl("file:///etc/passwd", { allowPrivateNetworks: true });
      }).toThrow(ProxyUrlValidationError);
    });
  });
});
