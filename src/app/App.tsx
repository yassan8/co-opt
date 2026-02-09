import { useEffect } from "react";
import MainToolbar from "../ui/components/MainToolbar";
import ConfigurationSection from "../ui/components/ConfigurationSection";
import SourceObjectSection from "../ui/components/SourceObjectSection";
import DesignIntentSection from "../ui/components/DesignIntentSection";
import RequirementsSection from "../ui/components/RequirementsSection";
import LegacyPanels from "../ui/components/LegacyPanels";

export default function App() {
  useEffect(() => {
    console.log("[React] App component mounted");
    
    // FIRST: Signal that React is mounted so main.ts can start initializing
    // This breaks the deadlock where main.ts waits for React and React waits for main.ts
    (window as typeof window & { __cooptReactMounted?: boolean })
      .__cooptReactMounted = true;
    window.dispatchEvent(new CustomEvent("coopt:react-mounted"));
    console.log("[React] coopt:react-mounted event dispatched immediately to trigger main.ts initialization");
    
    let attempts = 0;
    
    // Check if main.ts functions are available
    const checkMainTSReady = () => {
      const w = window as any;
      const ready = typeof w.getOpticalSystemRows === 'function' && 
                    typeof w.THREE !== 'undefined';
      if (!ready && attempts % 20 === 0) { // Log every 2 seconds
        console.log("[React] main.ts ready check:", {
          getOpticalSystemRows: typeof w.getOpticalSystemRows,
          THREE: typeof w.THREE,
          ready
        });
      }
      return ready;
    };
    
    const initializeAfterMainTS = () => {
      console.log("[React] main.ts is ready, initializing application features");
      
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
      
      // Refresh block inspector
      if (typeof (window as any).refreshBlockInspector === 'function') {
        try {
          (window as any).refreshBlockInspector();
          console.log("[React] Block inspector refreshed");
        } catch (err) {
          console.error("[React] Failed to refresh block inspector:", err);
        }
      }
      
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
    
    // Wait for main.ts to be ready
    if (checkMainTSReady()) {
      setTimeout(initializeAfterMainTS, 100);
    } else {
      console.log("[React] Waiting for main.ts to initialize...");
      let attempts = 0;
      const maxAttempts = 100; // Increase to 10 seconds
      const checkInterval = setInterval(() => {
        attempts++;
        if (checkMainTSReady()) {
          clearInterval(checkInterval);
          console.log(`[React] main.ts ready after ${attempts} attempts`);
          setTimeout(initializeAfterMainTS, 100);
        } else if (attempts >= maxAttempts) {
          clearInterval(checkInterval);
          console.warn(`[React] main.ts not ready after ${maxAttempts} attempts, initializing anyway...`);
          // Initialize anyway - most handlers will be set up by dom-event-handlers.ts
          setTimeout(() => {
            window.dispatchEvent(new CustomEvent("coopt:react-mounted"));
            console.log("[React] coopt:react-mounted event dispatched (delayed)");
          }, 100);
        }
      }, 100);
    }
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
      <div className="react-migration-badge" role="status" aria-live="polite">
        React移行中…
      </div>
    </>
  );
}
