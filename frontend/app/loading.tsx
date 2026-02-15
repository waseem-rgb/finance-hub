export default function Loading() {
  return (
    <div className="min-h-screen bg-[#070A12] p-6">
      <div className="mx-auto max-w-[1400px] space-y-4">
        <div className="h-20 animate-pulse rounded-3xl border border-white/10 bg-white/5" />
        <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
          <div className="h-36 animate-pulse rounded-2xl border border-white/10 bg-white/5" />
          <div className="h-36 animate-pulse rounded-2xl border border-white/10 bg-white/5" />
          <div className="h-36 animate-pulse rounded-2xl border border-white/10 bg-white/5" />
          <div className="h-36 animate-pulse rounded-2xl border border-white/10 bg-white/5" />
        </div>
      </div>
    </div>
  );
}
