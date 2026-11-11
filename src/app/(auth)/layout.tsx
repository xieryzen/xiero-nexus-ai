import { Wordmark, DesignedByXiero } from "@/components/brand";

export default function AuthLayout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col">
      <div className="flex flex-1 items-center justify-center px-4 py-12">
        <div className="w-full max-w-sm">
          <div className="mb-8 flex justify-center">
            <Wordmark />
          </div>
          {children}
        </div>
      </div>
      <footer className="flex flex-col items-center gap-1 pb-8 text-center">
        <p className="text-xs text-ink-3">One Command. Infinite Intelligence.</p>
        <DesignedByXiero />
      </footer>
    </div>
  );
}
