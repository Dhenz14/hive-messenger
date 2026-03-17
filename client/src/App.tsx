import { Switch, Route, Redirect, Router as WouterRouter } from "wouter";
import { queryClient } from "./lib/queryClient";
import { QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";
import { ThemeProvider } from "@/contexts/ThemeContext";
import { AuthProvider, useAuth } from "@/contexts/AuthContext";
import { ExceptionsProvider } from "@/contexts/ExceptionsContext";
import { HiddenConversationsProvider } from "@/contexts/HiddenConversationsContext";
import { KeychainRedirect } from "@/components/KeychainRedirect";
import Login from "@/pages/Login";
import Messages from "@/pages/Messages";
import NotFound from "@/pages/not-found";

// Vite injects BASE_URL from the `base` config (e.g., "/hive-messenger/" for GitHub Pages)
// Strip trailing slash for wouter's base prop
const basePath = import.meta.env.BASE_URL.replace(/\/$/, '') || '';

function ProtectedRoute({ component: Component }: { component: () => JSX.Element }) {
  const { user, isLoading, needsKeychainRedirect } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (needsKeychainRedirect) {
    return <KeychainRedirect />;
  }

  if (!user?.isAuthenticated) {
    return <Redirect to="/login" />;
  }

  return <Component />;
}

function PublicRoute({ component: Component }: { component: () => JSX.Element }) {
  const { user, isLoading, needsKeychainRedirect } = useAuth();

  if (isLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (needsKeychainRedirect) {
    return <KeychainRedirect />;
  }

  if (user?.isAuthenticated) {
    return <Redirect to="/" />;
  }

  return <Component />;
}

function AppRouter() {
  return (
    <Switch>
      <Route path="/" component={() => <ProtectedRoute component={Messages} />} />
      <Route path="/login" component={() => <PublicRoute component={Login} />} />
      <Route component={NotFound} />
    </Switch>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <ThemeProvider>
        <AuthProvider>
          <ExceptionsProvider>
            <HiddenConversationsProvider>
              <TooltipProvider>
                <Toaster />
                <WouterRouter base={basePath}>
                  <AppRouter />
                </WouterRouter>
              </TooltipProvider>
            </HiddenConversationsProvider>
          </ExceptionsProvider>
        </AuthProvider>
      </ThemeProvider>
    </QueryClientProvider>
  );
}

export default App;
