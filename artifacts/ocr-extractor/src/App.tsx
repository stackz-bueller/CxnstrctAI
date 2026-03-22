import { Switch, Route, Router as WouterRouter, Redirect } from "wouter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Toaster } from "@/components/ui/toaster";
import { TooltipProvider } from "@/components/ui/tooltip";

import { Layout } from "@/components/layout";
import ExtractPage from "@/pages/extract";
import SchemasPage from "@/pages/schemas";
import SchemaNewPage from "@/pages/schema-new";
import HistoryPage from "@/pages/history";
import ExtractionDetailsPage from "@/pages/extraction-details";
import PdfExtractPage from "@/pages/pdf-extract";
import SpecExtractPage from "@/pages/spec-extract";
import SmartUploadPage from "@/pages/smart-upload";
import NotFound from "@/pages/not-found";

const queryClient = new QueryClient();

function Router() {
  return (
    <Layout>
      <Switch>
        <Route path="/" component={SmartUploadPage} />
        <Route path="/extract" component={ExtractPage} />
        <Route path="/schemas" component={SchemasPage} />
        <Route path="/schemas/new" component={SchemaNewPage} />
        <Route path="/history" component={HistoryPage} />
        <Route path="/extractions/:id" component={ExtractionDetailsPage} />
        <Route path="/pdf-extract" component={PdfExtractPage} />
        <Route path="/spec-extract" component={SpecExtractPage} />
        <Route component={NotFound} />
      </Switch>
    </Layout>
  );
}

function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <TooltipProvider>
        <WouterRouter base={import.meta.env.BASE_URL.replace(/\/$/, "")}>
          <Router />
        </WouterRouter>
        <Toaster />
      </TooltipProvider>
    </QueryClientProvider>
  );
}

export default App;
