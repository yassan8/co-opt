import { useEffect } from "react";
import MainToolbar from "../ui/components/MainToolbar";
import ConfigurationSection from "../ui/components/ConfigurationSection";
import SourceObjectSection from "../ui/components/SourceObjectSection";
import DesignIntentSection from "../ui/components/DesignIntentSection";
import RequirementsSection from "../ui/components/RequirementsSection";
import LegacyPanels from "../ui/components/LegacyPanels";

export default function App() {
  useEffect(() => {
    console.log("[React] App component mounted, dispatching coopt:react-mounted event");
    (window as typeof window & { __cooptReactMounted?: boolean })
      .__cooptReactMounted = true;
    window.dispatchEvent(new CustomEvent("coopt:react-mounted"));

    // レガシー初期化関数を呼び出す
    // DOMが準備できたので、テーブルやイベントハンドラーを初期化
    setTimeout(() => {
      console.log("[React] Initializing legacy tables and handlers");
      
      // main.jsの初期化が完了するのを待ってから、テーブルを再初期化
      if (typeof (window as any).initializeAllTables === 'function') {
        (window as any).initializeAllTables();
      }
      
      // イベントハンドラーの再バインド (Configuration UI含む)
      if (typeof (window as any).rebindEventHandlers === 'function') {
        (window as any).rebindEventHandlers();
      }
      
      // Configuration UIを確実に初期化
      if (typeof (window as any).initializeConfigurationUI === 'function') {
        (window as any).initializeConfigurationUI();
      }
    }, 100);
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
