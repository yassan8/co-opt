import { useEffect } from "react";
import MainToolbar from "../ui/components/MainToolbar";
import ConfigurationSection from "../ui/components/ConfigurationSection";
import SourceObjectSection from "../ui/components/SourceObjectSection";
import DesignIntentSection from "../ui/components/DesignIntentSection";
import RequirementsSection from "../ui/components/RequirementsSection";
import LegacyPanels from "../ui/components/LegacyPanels";

export default function App() {
  useEffect(() => {
    (window as typeof window & { __cooptReactMounted?: boolean })
      .__cooptReactMounted = true;
    window.dispatchEvent(new CustomEvent("coopt:react-mounted"));
  }, []);

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
