import { useEffect } from "react";
import MainToolbar from "../ui/components/MainToolbar";
import ConfigurationSection from "../ui/components/ConfigurationSection";
import SourceObjectSection from "../ui/components/SourceObjectSection";
import DesignIntentSection from "../ui/components/DesignIntentSection";
import RequirementsSection from "../ui/components/RequirementsSection";
import LegacyPanels from "../ui/components/LegacyPanels";
import { requestRefreshBlockInspector } from "../../core/window-facade.ts";

export default function App() {
  useEffect(() => {
    console.log("[React] App component mounted");
    
    // FIRST: Signal that React is mounted so main.ts can start initializing
    // This breaks the deadlock where main.ts waits for React and React waits for main.ts
    (window as typeof window & { __cooptReactMounted?: boolean })
      .__cooptReactMounted = true;
    window.dispatchEvent(new CustomEvent("coopt:react-mounted"));
    console.log("[React] coopt:react-mounted event dispatched immediately to trigger main.ts initialization");

    const w = window as any;
    
    const initializeAfterMainTS = (mode: "main-ready" | "module-loaded" | "fallback") => {
      if (mode === "main-ready") {
        console.log("[React] main.ts is ready, initializing application features");
      } else if (mode === "module-loaded") {
        console.log("[React] main.ts module loaded, starting best-effort initialization");
      } else {
        console.log("[React] Proceeding with fallback initialization");
      }
      
      // Load active configuration to tables (this expands Blocks to Optical System rows)
      console.log("[React] Loading active configuration to tables...");
      if (typeof (window as any).loadActiveConfigurationToTables === 'function') {
        try {
          (window as any).loadActiveConfigurationToTables();
          console.log("[React] Active configuration loaded");
        } catch (err) {
          console.error("[React] Failed to load active configuration:", err);
        }
      }
      
      // Initialize tables
      if (typeof (window as any).initializeAllTables === 'function') {
        (window as any).initializeAllTables();
      }
      
      requestRefreshBlockInspector();
      
      // Ensure analysis windows are set up
      console.log("[React] Setting up analysis windows directly...");
      if (typeof (window as any).setupAnalysisWindows === 'function') {
        (window as any).setupAnalysisWindows();
      }
      if (typeof (window as any).setupOpticalSystemChangeListeners === 'function') {
        (window as any).setupOpticalSystemChangeListeners(null);
      }
      
      // Verify optical system data is available
      setTimeout(() => {
        const w = window as any;
        if (typeof w.getOpticalSystemRows === 'function' && w.tableOpticalSystem) {
          const rows = w.getOpticalSystemRows(w.tableOpticalSystem);
          console.log("[React] Optical system rows available:", rows?.length || 0);
        }
      }, 200);
    };

    const isMainReady = () => !!w.__cooptMainReady;
    const isMainModuleLoaded = () => !!w.__cooptMainModuleLoaded || typeof w.getOpticalSystemRows === "function";

    if (isMainReady()) {
      setTimeout(() => initializeAfterMainTS("main-ready"), 0);
      return;
    }

    if (isMainModuleLoaded()) {
      setTimeout(() => initializeAfterMainTS("module-loaded"), 0);
      return;
    }

    console.log("[React] Waiting for main.ts bootstrap events...");
    let initialized = false;
    const completeInit = (mode: "main-ready" | "module-loaded" | "fallback") => {
      if (initialized) return;
      initialized = true;
      setTimeout(() => initializeAfterMainTS(mode), 0);
    };

    const onMainReady = () => completeInit("main-ready");
    const onMainModuleLoaded = () => completeInit("module-loaded");
    const onMainLoadFailed = (evt: Event) => {
      const detail = (evt as CustomEvent<any>)?.detail;
      console.error("[React] main.ts load failed", detail || { message: w.__cooptMainLoadError || "unknown" });
    };

    window.addEventListener("coopt:main-ready", onMainReady, { once: true });
    window.addEventListener("coopt:main-module-loaded", onMainModuleLoaded, { once: true });
    window.addEventListener("coopt:main-load-failed", onMainLoadFailed);

    const fallbackTimer = window.setTimeout(() => {
      if (initialized) return;
      const status = {
        getOpticalSystemRows: typeof w.getOpticalSystemRows,
        initializeAllTables: typeof w.initializeAllTables,
        loadActiveConfigurationToTables: typeof w.loadActiveConfigurationToTables,
        mainReadyFlag: !!w.__cooptMainReady,
        mainModuleLoaded: !!w.__cooptMainModuleLoaded,
        mainLoadError: w.__cooptMainLoadError || null
      };
      if (status.mainLoadError) {
        console.warn("[React] main bootstrap timeout after load error, proceeding with fallback", status);
      } else {
        console.info("[React] main bootstrap slow-start, proceeding with fallback", status);
      }
      completeInit("fallback");
    }, 30000);

    return () => {
      window.clearTimeout(fallbackTimer);
      window.removeEventListener("coopt:main-ready", onMainReady);
      window.removeEventListener("coopt:main-module-loaded", onMainModuleLoaded);
      window.removeEventListener("coopt:main-load-failed", onMainLoadFailed);
    };
  }, []);

  console.log("[React] Rendering App component");
  return (
    <>
      <MainToolbar />
      <ConfigurationSection />
      <SourceObjectSection />
      <DesignIntentSection />
      <RequirementsSection />
      <LegacyPanels />
    </>
  );
}
