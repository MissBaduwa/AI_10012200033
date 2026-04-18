import { AppHeader } from "@/components/AppHeader";
import { ChatMessages } from "@/components/ChatMessages";
import { ChatInput } from "@/components/ChatInput";
import { QuickSuggestions } from "@/components/QuickSuggestions";
import { RetrievalPanel } from "@/components/RetrievalPanel";
import { LogViewer } from "@/components/LogViewer";
import { StatsFooter } from "@/components/StatsFooter";

const Index = () => {
  return (
    <div className="h-screen flex flex-col adinkra-bg">
      <AppHeader />

      <div className="flex-1 flex overflow-hidden">
        {/* Main chat area */}
        <div className="flex-1 flex flex-col min-w-0">
          <ChatMessages />
          <QuickSuggestions />
          <LogViewer />
          <ChatInput />
        </div>

        {/* Retrieval sidebar - hidden on mobile */}
        <div className="hidden lg:flex">
          <RetrievalPanel />
        </div>
      </div>

      <StatsFooter />
    </div>
  );
};

export default Index;
