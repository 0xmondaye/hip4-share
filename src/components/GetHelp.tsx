import { TelegramLogo } from "./TelegramLogo"

/** One tap to a human, embedded in every money flow — a stuck payment should
 *  read as "ask us on Telegram", not "funds gone". */
export function GetHelp({ className = "" }: { className?: string }) {
  return (
    <a
      href="https://t.me/+UMKzaeUVv7VjOTk1"
      target="_blank"
      rel="noreferrer noopener"
      className={`inline-flex items-center justify-center gap-1.5 text-xs text-muted-foreground transition hover:text-foreground ${className}`}
    >
      <TelegramLogo className="size-3.5 shrink-0" />
      <span>
        Need help? <span className="underline underline-offset-2">Ask on Telegram</span>
      </span>
    </a>
  )
}
