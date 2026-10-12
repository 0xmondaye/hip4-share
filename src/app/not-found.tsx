import Link from "next/link";

// ponytail: Next's default 404 injects its own body{background:#fff} style,
// ignoring the .dark theme — a custom not-found keeps the app shell + palette.
export default function NotFound() {
  return (
    <div className="flex flex-col items-center justify-center gap-4 py-24 text-center">
      <div className="font-heading text-6xl text-brand">404</div>
      <p className="text-sm text-muted-foreground">
        This market doesn&apos;t exist — or it already resolved.
      </p>
      <Link
        href="/"
        className="px-4 py-2 rounded-md bg-surface-2 text-sm hover:text-brand transition"
      >
        Back to markets
      </Link>
    </div>
  );
}
