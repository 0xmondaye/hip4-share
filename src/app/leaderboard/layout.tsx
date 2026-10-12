// "use client" pages can't export metadata; the title lives here instead.
export const metadata = { title: "Leaderboard — Speculate" };

export default function LeaderboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return children;
}
