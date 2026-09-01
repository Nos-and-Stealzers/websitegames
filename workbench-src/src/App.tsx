import { useState } from "react";
import { AuthProvider, useAuth } from "./auth/AuthProvider";
import { AuthScreen } from "./auth/AuthScreen";
import { ToastProvider } from "./ui/Toasts";
import { Spinner } from "./ui/Spinner";
import { Dashboard } from "./dashboard/Dashboard";
import { SessionView } from "./session/SessionView";
import { AccountSettingsPage } from "./account/AccountSettingsPage";
import { HelpPage } from "./help/HelpPage";
import "./App.css";

interface ActiveTarget {
  hostId: string;
  name: string;
  pin?: string;
}

function AppShell() {
  const { session } = useAuth();
  const [target, setTarget] = useState<ActiveTarget | null>(null);
  const [accountSettingsOpen, setAccountSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  // undefined = the stored session is still being restored from localStorage. Holding a splash
  // here (instead of rendering AuthScreen first) is what makes a returning visit feel instant
  // rather than flashing a sign-in form at someone who's already signed in.
  if (session === undefined) {
    return (
      <div className="boot-splash">
        <Spinner size={28} />
      </div>
    );
  }

  if (!session) return <AuthScreen />;

  if (target) {
    return <SessionView hostId={target.hostId} name={target.name} pin={target.pin} onExit={() => setTarget(null)} />;
  }

  if (accountSettingsOpen) {
    return <AccountSettingsPage onBack={() => setAccountSettingsOpen(false)} />;
  }

  if (helpOpen) {
    return <HelpPage onBack={() => setHelpOpen(false)} />;
  }

  return (
    <Dashboard
      onConnect={(hostId, name, pin) => setTarget({ hostId, name, pin })}
      onOpenAccountSettings={() => setAccountSettingsOpen(true)}
      onOpenHelp={() => setHelpOpen(true)}
    />
  );
}

function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <AppShell />
      </ToastProvider>
    </AuthProvider>
  );
}

export default App;
