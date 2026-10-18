import { cn } from "@/lib/utils";

// openzo mark: an open ring with a single point — "your own zo".
export function Logo({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={cn("size-6", className)} fill="none" aria-hidden>
      <path d="M26 16a10 10 0 1 1-4.1-8.08" stroke="currentColor" strokeWidth="3" strokeLinecap="round" />
      <circle cx="25.2" cy="8.6" r="2.6" fill="currentColor" />
    </svg>
  );
}
