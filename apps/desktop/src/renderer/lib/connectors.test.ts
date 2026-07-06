import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  registerConnector,
  unregisterConnector,
  getConnectorConfigs,
  removeConnectorConfig,
  shutdownConnectors,
  type Connector,
  type ConnectorConfig,
} from "./connectors";

function createMockConnector(id: string, name: string): Connector {
  return {
    id,
    name,
    type: "webhook",
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    isConnected: vi.fn().mockReturnValue(true),
    sendMessage: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockReturnValue({ connected: true }),
  };
}

describe("connectors", () => {
  beforeEach(async () => {
    await shutdownConnectors();
    localStorage.clear();
  });

  describe("registerConnector", () => {
    it("registers a connector", () => {
      const connector = createMockConnector("c1", "Test Connector");
      registerConnector(connector);
      expect(() => unregisterConnector("c1")).not.toThrow();
    });

    it("overwrites existing connector with same id", () => {
      const c1 = createMockConnector("c1", "First");
      const c2 = createMockConnector("c1", "Second");
      registerConnector(c1);
      registerConnector(c2);
      unregisterConnector("c1");
      expect(c2.stop).toHaveBeenCalled();
    });
  });

  describe("unregisterConnector", () => {
    it("stops and removes connector", async () => {
      const connector = createMockConnector("c1", "Test");
      registerConnector(connector);
      unregisterConnector("c1");
      expect(connector.stop).toHaveBeenCalled();
    });

    it("handles unknown id gracefully", () => {
      expect(() => unregisterConnector("nonexistent")).not.toThrow();
    });
  });

  describe("getConnectorConfigs", () => {
    it("returns empty array when no configs exist", () => {
      const configs = getConnectorConfigs();
      expect(Array.isArray(configs)).toBe(true);
      expect(configs.length).toBe(0);
    });
  });

  describe("removeConnectorConfig", () => {
    it("removes a config by id", () => {
      const config: ConnectorConfig = {
        id: "c1",
        name: "Test",
        type: "webhook",
        enabled: true,
        config: { port: 3847, path: "/webhook" },
      };
      localStorage.setItem("dalam.connectorConfigs.v1", JSON.stringify([config]));
      removeConnectorConfig("c1");
      const configs = getConnectorConfigs();
      expect(configs.find(c => c.id === "c1")).toBeUndefined();
    });

    it("stops the connector if running", async () => {
      const connector = createMockConnector("c1", "Test");
      registerConnector(connector);
      removeConnectorConfig("c1");
      expect(connector.stop).toHaveBeenCalled();
    });
  });

  describe("shutdownConnectors", () => {
    it("stops all connectors and clears registry", async () => {
      const c1 = createMockConnector("c1", "First");
      const c2 = createMockConnector("c2", "Second");
      registerConnector(c1);
      registerConnector(c2);
      await shutdownConnectors();
      expect(c1.stop).toHaveBeenCalled();
      expect(c2.stop).toHaveBeenCalled();
    });

    it("handles stop failures gracefully", async () => {
      const connector = createMockConnector("c1", "Fail");
      (connector.stop as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("stop failed"));
      registerConnector(connector);
      await expect(shutdownConnectors()).resolves.not.toThrow();
    });
  });

  describe("Connector interface", () => {
    it("connector implements required interface", () => {
      const connector = createMockConnector("c1", "Test");
      expect(connector.id).toBe("c1");
      expect(connector.name).toBe("Test");
      expect(typeof connector.start).toBe("function");
      expect(typeof connector.stop).toBe("function");
      expect(typeof connector.isConnected).toBe("function");
      expect(typeof connector.sendMessage).toBe("function");
      expect(typeof connector.getStatus).toBe("function");
    });

    it("connector start/stop lifecycle", async () => {
      const connector = createMockConnector("c1", "Test");
      const events = {
        onMessage: vi.fn(),
        onStatusChange: vi.fn(),
      };
      await connector.start(events);
      expect(connector.start).toHaveBeenCalledWith(events);
      expect(connector.isConnected()).toBe(true);

      await connector.stop();
      expect(connector.stop).toHaveBeenCalled();
    });
  });
});
