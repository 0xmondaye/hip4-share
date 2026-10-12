"use client"

// Admin panel. Three jobs: see who the users are, control who gets in, and
// hand out free packs — plus an audit trail of every admin action and a design
// preview for the in-house gacha we haven't built yet.
//
// Everything on the first two tabs edits tables that already existed and were
// previously maintained by hand in the Neon console (gacha_allowlist,
// gacha_credits). That is the whole point: no new concepts, no new storage,
// just the SQL an operator was already running, with the footguns removed.
//
// Auth is handled by src/proxy.ts before this page renders (HTTP Basic, or a
// signed-in Privy session with an admin email) — so there is no login screen
// here and no credential in JS. Emails are shown WHOLE (unlike the public
// leaderboard, which masks them): acting on the wrong person is the failure
// mode this page has to prevent.

import { useCallback, useEffect, useMemo, useState } from "react"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import {
  mergeUsers,
  type CreditRow,
  type DashUser,
  type SpendRow,
} from "@/lib/admin-core"
import { markedPack } from "@/lib/gacha-core"
import { listPacks } from "@/lib/slabz"
import { InventoryDesign } from "./InventoryDesign"
import { money, Panel, shortSubject, Stat } from "./ui"

/** Neon's half: fast, always available, and the half an admin acts on. */
type Data = {
  credits: CreditRow[]
  allowlist: string[]
  spend: SpendRow[]
  actor: string
  giftConfigured: boolean
}

/** The dashboard's half: slow (40-70s cold) and served from a snapshot, so it
 *  is fetched on its own and never holds up the rest of the page. */
type Directory = { wallets: DashUser[]; fetchedAt: string | null; refreshing: boolean }

type AuditEntry = {
  id: number
  actor: string
  action: string
  detail: Record<string, unknown>
  at: string
}

export default function AdminPage() {
  const [data, setData] = useState<Data | null>(null)
  const [dir, setDir] = useState<Directory | null>(null)
  const [auditRows, setAuditRows] = useState<AuditEntry[] | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [dirError, setDirError] = useState<string | null>(null)
  const [tab, setTab] = useState("users")
  const [q, setQ] = useState("")
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: "ok" | "err"; text: string } | null>(null)
  const [packNames, setPackNames] = useState<string[]>([])
  const [grant, setGrant] = useState({ subject: "", packName: "", packs: 1, reason: "" })

  const get = async (path: string) => {
    const res = await fetch(path).catch(() => null)
    if (!res?.ok) {
      const why = (await res?.json().catch(() => null)) as { error?: { message?: string } } | null
      throw new Error(why?.error?.message ?? `couldn't load (${res?.status ?? "network"})`)
    }
    return res.json()
  }

  const load = useCallback(async () => {
    setLoadError(null)
    await get("/admin/api")
      .then((d) => setData(d as Data))
      .catch((e: Error) => setLoadError(e.message))
  }, [])

  const loadDirectory = useCallback(async () => {
    setDirError(null)
    await get("/admin/api?directory=1")
      .then((d) => setDir(d as Directory))
      .catch((e: Error) => setDirError(e.message))
  }, [])

  const loadAudit = useCallback(async () => {
    await get("/admin/api?audit=1")
      .then((d) => setAuditRows((d as { entries: AuditEntry[] }).entries))
      .catch(() => setAuditRows([]))
  }, [])

  useEffect(() => {
    void load()
    void loadDirectory()
    // Marked names, not raw Slabz names: a credit's pack_name is compared
    // against the MARKED display name ("Pokemon 30"), so offering "Pokemon 25"
    // here would write rows that can never be redeemed.
    listPacks()
      .then((ps) => setPackNames([...new Set(ps.map((p) => markedPack(p).name))].sort()))
      .catch(() => setPackNames([]))
  }, [load, loadDirectory])

  // the audit tab is the only lazy one: nobody reads it on most visits
  useEffect(() => {
    if (tab === "audit" && auditRows === null) void loadAudit()
  }, [tab, auditRows, loadAudit])

  /** Every write goes through here: one place that shows the result, reloads,
   *  and can't leave the buttons stuck enabled mid-flight. */
  const act = useCallback(
    async (body: Record<string, unknown>, okText: string) => {
      setBusy(true)
      setMsg(null)
      try {
        const res = await fetch("/admin/api", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        const json = (await res.json().catch(() => ({}))) as {
          error?: { message?: string }
          inserted?: boolean
        }
        if (!res.ok) {
          setMsg({ tone: "err", text: json.error?.message ?? `failed (${res.status})` })
          return false
        }
        setMsg({
          tone: "ok",
          text:
            json.inserted === false
              ? "already granted — same subject and reason, nothing changed"
              : okText,
        })
        setAuditRows(null) // stale now; refetched if the tab is opened
        await load()
        return true
      } finally {
        setBusy(false)
      }
    },
    [load],
  )

  // Merged in the browser with the same pure function the server would have
  // used — the two halves arrive independently, so joining them here is what
  // lets the fast half render without waiting for the slow one.
  const users = useMemo(() => {
    if (!data || !dir) return []
    const rows = mergeUsers({ ...data, wallets: dir.wallets })
    const needle = q.trim().toLowerCase()
    if (!needle) return rows
    return rows.filter((u) =>
      [u.label, u.address, u.privyId, ...u.subjects].some((s) => s?.toLowerCase().includes(needle)),
    )
  }, [data, dir, q])

  const openToAll = (data?.allowlist ?? []).includes("*")
  const unclaimed = data?.credits.filter((c) => !c.giftId).length ?? 0
  const revenueCents = data?.spend.reduce((n, s) => n + s.cents, 0) ?? 0

  const startGrant = (subject: string) => {
    // Key on the DID: it is the one subject the gate matches for every login
    // type (email, wallet, OAuth), so a DID-keyed grant can never miss.
    setGrant((g) => ({ ...g, subject }))
    setTab("credits")
    setMsg(null)
  }

  return (
    <div className="mx-auto w-full max-w-6xl pb-16">
      <div className="mb-4 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-heading text-2xl">Admin</h1>
          <p className="text-xs text-muted-foreground">
            Users, access and free packs. Every change here is live, and every change is logged.
          </p>
        </div>
        <div className="flex items-center gap-2">
          {data?.actor && (
            <Badge variant="outline" className="font-mono text-[11px]">
              {data.actor === "basic-key" ? "signed in with the shared key" : data.actor}
            </Badge>
          )}
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              void load()
              void loadDirectory()
              setAuditRows(null)
            }}
            disabled={busy}
          >
            Refresh
          </Button>
        </div>
      </div>

      <div className="mb-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Stat label="Users" value={dir ? dir.wallets.length : "—"} sub="signed up" />
        <Stat
          label="With access"
          value={openToAll ? "everyone" : data ? data.allowlist.length : "—"}
          sub={openToAll ? "beta is open" : "allowlist rows"}
        />
        <Stat label="Unclaimed packs" value={data ? unclaimed : "—"} sub="granted, not redeemed" />
        <Stat label="Pack revenue" value={data ? money(revenueCents) : "—"} sub="paid pulls, all time" />
      </div>

      {loadError && (
        <p className="mb-4 rounded-xl border border-no/40 bg-no/10 px-4 py-3 text-sm text-no">
          {loadError}
        </p>
      )}
      {dirError && (
        <p className="mb-4 rounded-xl border border-border bg-surface px-4 py-3 text-xs text-muted-foreground">
          User directory unavailable ({dirError}). Access and free packs still work — add people by
          email or address by hand.{" "}
          <button className="underline underline-offset-2" onClick={() => void loadDirectory()}>
            Retry
          </button>
        </p>
      )}
      {msg && (
        <p
          className={`mb-4 rounded-xl border px-4 py-3 text-sm ${
            msg.tone === "ok" ? "border-yes/40 bg-yes/10 text-yes" : "border-no/40 bg-no/10 text-no"
          }`}
        >
          {msg.text}
        </p>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(String(v))}>
        <TabsList variant="line" className="mb-4">
          <TabsTrigger value="users">Users {dir ? `(${dir.wallets.length})` : ""}</TabsTrigger>
          <TabsTrigger value="credits">
            Free packs {data ? `(${unclaimed})` : ""}
          </TabsTrigger>
          <TabsTrigger value="audit">Audit</TabsTrigger>
          <TabsTrigger value="inventory">Inventory</TabsTrigger>
        </TabsList>

        {/* ---- users ------------------------------------------------------ */}
        <TabsContent value="users" className="space-y-4">
          {openToAll && (
            <p className="rounded-xl border border-brand/40 bg-brand/10 px-4 py-3 text-sm">
              Packs are <strong>open to everyone</strong> — the allowlist holds a{" "}
              <code>*</code> row, so per-user access below is ignored.{" "}
              <button
                className="underline underline-offset-2"
                disabled={busy}
                onClick={() => void act({ action: "revoke", subject: "*" }, "Beta closed again.")}
              >
                Close the beta
              </button>
            </p>
          )}

          {/* The directory is a snapshot, and saying so matters: an admin who
              just changed something needs to know why a row hasn't moved. */}
          <Panel
            title="Directory"
            hint={
              dir?.fetchedAt
                ? `Snapshot from ${new Date(dir.fetchedAt).toLocaleTimeString()}${
                    dir.refreshing ? " · refreshing in the background" : ""
                  }. Access is live.`
                : "Everyone who has signed up. Access controls the gacha allowlist."
            }
            right={
              <Input
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search email, wallet, DID…"
                className="h-8 w-full sm:w-64"
                aria-label="Search users"
              />
            }
          >
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>User</TableHead>
                    <TableHead>Access</TableHead>
                    <TableHead className="text-right">Free packs</TableHead>
                    <TableHead className="text-right">Pulls</TableHead>
                    <TableHead className="text-right">Pack spend</TableHead>
                    <TableHead className="text-right">HL volume</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {users.map((u) => (
                    <TableRow key={u.privyId || u.address}>
                      <TableCell className="max-w-[22rem]">
                        <div className="truncate font-medium">{u.label}</div>
                        <div className="truncate font-mono text-[11px] text-muted-foreground">
                          {u.address || u.privyId}
                        </div>
                      </TableCell>
                      <TableCell>
                        <Badge variant={u.allowlisted ? "default" : "outline"}>
                          {u.allowlisted ? "allowed" : "no access"}
                        </Badge>
                      </TableCell>
                      <TableCell className="text-right tabular-nums">
                        {u.credits || "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{u.pulls || "—"}</TableCell>
                      <TableCell className="text-right tabular-nums">
                        {u.spentCents ? money(u.spentCents) : "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-muted-foreground">
                        {u.volumeUSDC ? `$${Math.round(u.volumeUSDC).toLocaleString()}` : "—"}
                      </TableCell>
                      <TableCell className="text-right whitespace-nowrap">
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={busy || openToAll}
                          onClick={() =>
                            void act(
                              {
                                action: u.allowlisted ? "revoke" : "allow",
                                // revoke has to remove the row that actually
                                // grants access, which may be any of their
                                // subjects — not necessarily the DID we add.
                                subject: u.allowlisted
                                  ? (data?.allowlist ?? []).find((a) =>
                                      u.subjects.includes(a.toLowerCase()),
                                    ) ?? u.privyId
                                  : u.privyId,
                              },
                              u.allowlisted ? `Access removed for ${u.label}.` : `${u.label} can pull packs.`,
                            )
                          }
                        >
                          {u.allowlisted ? "Revoke" : "Allow"}
                        </Button>
                        <Button size="sm" variant="ghost" onClick={() => startGrant(u.privyId)}>
                          Grant
                        </Button>
                      </TableCell>
                    </TableRow>
                  ))}
                  {users.length === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                        {!dir && !dirError
                          ? "Loading the directory — first load after a while can take a minute."
                          : dirError
                            ? "Directory unavailable."
                            : "No users match."}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </Panel>

          <Panel
            title="Access by hand"
            hint="For someone who hasn't signed up yet, or a wallet-only user. Email, wallet address, Privy DID — or '*' to open the beta to everyone."
          >
            <form
              className="flex flex-wrap items-center gap-2 px-4 py-3"
              onSubmit={(e) => {
                e.preventDefault()
                const subject = new FormData(e.currentTarget).get("subject")
                if (subject) void act({ action: "allow", subject }, `${subject} can pull packs.`)
                e.currentTarget.reset()
              }}
            >
              <Input
                name="subject"
                required
                placeholder="someone@example.com"
                className="h-9 w-full sm:w-96"
                aria-label="Subject to allow"
              />
              <Button type="submit" size="sm" disabled={busy}>
                Allow
              </Button>
            </form>
            {(data?.allowlist.length ?? 0) > 0 && (
              <div className="flex flex-wrap gap-1.5 border-t border-border px-4 py-3">
                {data!.allowlist.map((a) => (
                  <button
                    key={a}
                    disabled={busy}
                    title="Remove"
                    onClick={() => void act({ action: "revoke", subject: a }, `Removed ${a}.`)}
                    className="rounded-full border border-border px-2.5 py-1 font-mono text-[11px] hover:border-no hover:text-no"
                  >
                    {shortSubject(a)} ×
                  </button>
                ))}
              </div>
            )}
          </Panel>
        </TabsContent>

        {/* ---- free packs ------------------------------------------------- */}
        <TabsContent value="credits" className="space-y-4">
          <Panel
            title="Grant free packs"
            hint="Writes an entitlement the user redeems themselves. Nothing is spent until they claim it — the house funder pays then."
          >
            <form
              className="grid gap-3 px-4 py-4 sm:grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_5rem_minmax(0,1.4fr)_auto]"
              onSubmit={(e) => {
                e.preventDefault()
                void act({ action: "grant", ...grant }, `Granted ${grant.packs}× to ${grant.subject}.`)
              }}
            >
              <label className="text-xs text-muted-foreground">
                Who
                <Input
                  required
                  value={grant.subject}
                  onChange={(e) => setGrant({ ...grant, subject: e.target.value })}
                  placeholder="email / wallet / did:privy:…"
                  className="mt-1 h-9 font-mono text-xs"
                />
              </label>
              <label className="text-xs text-muted-foreground">
                Pack
                <Input
                  required
                  list="pack-names"
                  value={grant.packName}
                  onChange={(e) => setGrant({ ...grant, packName: e.target.value })}
                  placeholder="* (any pack)"
                  className="mt-1 h-9"
                />
                <datalist id="pack-names">
                  <option value="*" />
                  {packNames.map((n) => (
                    <option key={n} value={n} />
                  ))}
                </datalist>
              </label>
              <label className="text-xs text-muted-foreground">
                Packs
                <Input
                  required
                  type="number"
                  min={1}
                  max={5}
                  value={grant.packs}
                  onChange={(e) => setGrant({ ...grant, packs: Number(e.target.value) })}
                  className="mt-1 h-9 tabular-nums"
                />
              </label>
              <label className="text-xs text-muted-foreground">
                Reason
                <Input
                  required
                  value={grant.reason}
                  onChange={(e) => setGrant({ ...grant, reason: e.target.value })}
                  placeholder="beta-2026-08"
                  className="mt-1 h-9"
                />
              </label>
              <Button type="submit" size="sm" disabled={busy} className="self-end">
                Grant
              </Button>
            </form>
            <p className="border-t border-border px-4 py-2.5 text-xs text-muted-foreground">
              {grant.packName && grant.packName !== "*" && packNames.length > 0 &&
              !packNames.some((n) => n.toLowerCase() === grant.packName.trim().toLowerCase()) ? (
                <span className="text-no">
                  “{grant.packName}” isn&apos;t a pack in the live catalog — a credit that names no
                  real pack can never be redeemed.
                </span>
              ) : (
                <>
                  <strong>Reason</strong> is the idempotency key: the same person and the same
                  reason can only ever be granted once, so re-running a campaign is safe.
                </>
              )}
            </p>
          </Panel>

          <Panel title="Ledger" hint="Every grant, redeemed or not. Unredeemed ones can be revoked.">
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Who</TableHead>
                    <TableHead>Pack</TableHead>
                    <TableHead className="text-right">Packs</TableHead>
                    <TableHead>Reason</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead>Granted</TableHead>
                    <TableHead />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(data?.credits ?? []).map((c) => (
                    <TableRow key={c.id}>
                      <TableCell className="font-mono text-xs">{shortSubject(c.subject)}</TableCell>
                      <TableCell>{c.packName === "*" ? "any pack" : c.packName}</TableCell>
                      <TableCell className="text-right tabular-nums">{c.packs}</TableCell>
                      <TableCell className="text-xs text-muted-foreground">{c.reason}</TableCell>
                      <TableCell>
                        {c.giftId === null ? (
                          <Badge variant="outline">unclaimed</Badge>
                        ) : c.giftId === "pending" ? (
                          <Badge variant="secondary">minting</Badge>
                        ) : (
                          <Badge>claimed</Badge>
                        )}
                        {/* a row stuck at the retry cap is an ops signal: the
                            funder is broken, not the user */}
                        {c.attempts >= 10 && (
                          <span className="ml-1.5 text-xs text-no">stuck ({c.attempts} tries)</span>
                        )}
                      </TableCell>
                      <TableCell className="text-xs text-muted-foreground">
                        {c.createdAt.slice(0, 10)}
                      </TableCell>
                      <TableCell className="text-right">
                        {c.giftId === null && (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={busy}
                            onClick={() => void act({ action: "ungrant", id: c.id }, "Grant revoked.")}
                          >
                            Revoke
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                  {(data?.credits.length ?? 0) === 0 && (
                    <TableRow>
                      <TableCell colSpan={7} className="py-10 text-center text-muted-foreground">
                        {data ? "Nothing granted yet." : "Loading…"}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </Panel>
        </TabsContent>

        {/* ---- audit ------------------------------------------------------ */}
        <TabsContent value="audit">
          <Panel
            title="Audit log"
            hint="Every admin action, who performed it, and when. Append-only — nothing on this panel can edit it."
            right={
              <Button variant="outline" size="sm" onClick={() => void loadAudit()}>
                Reload
              </Button>
            }
          >
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Who</TableHead>
                    <TableHead>Action</TableHead>
                    <TableHead>Detail</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(auditRows ?? []).map((e) => (
                    <TableRow key={e.id}>
                      <TableCell className="whitespace-nowrap text-xs text-muted-foreground">
                        {new Date(e.at).toLocaleString()}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{e.actor}</TableCell>
                      <TableCell>
                        <Badge variant="outline">{e.action}</Badge>
                      </TableCell>
                      <TableCell className="max-w-[28rem] truncate font-mono text-[11px] text-muted-foreground">
                        {JSON.stringify(e.detail)}
                      </TableCell>
                    </TableRow>
                  ))}
                  {(auditRows?.length ?? 0) === 0 && (
                    <TableRow>
                      <TableCell colSpan={4} className="py-10 text-center text-muted-foreground">
                        {auditRows === null ? "Loading…" : "No admin actions recorded yet."}
                      </TableCell>
                    </TableRow>
                  )}
                </TableBody>
              </Table>
            </div>
          </Panel>
        </TabsContent>

        <TabsContent value="inventory">
          <InventoryDesign />
        </TabsContent>
      </Tabs>
    </div>
  )
}
