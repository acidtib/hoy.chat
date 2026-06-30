## Wrapping and setup

Wrap any build that uses `Tooltip` in `TooltipProvider` (from `window.HoyUI.TooltipProvider`) once, near the root — `Tooltip` throws "must be used within Provider" without it:

```jsx
<TooltipProvider delayDuration={200}>
  {/* rest of the app */}
</TooltipProvider>
```

This is a **dark-only** product today — there is no light/dark toggle in the app. Render the root with `class="dark"` on the `<html>`/wrapping element so the dark token values apply; without it you get the light-theme tokens, which is not how this product ships.

## Styling idiom: CSS custom-property tokens via Tailwind utilities

No bespoke class vocabulary — style with **standard Tailwind utility classes that read CSS custom-property tokens**, never raw hex/oklch values. The token names (defined in `:root` and `.dark`, consumed via `@theme inline`) are the real API:

| Token | Tailwind utility | Use |
|---|---|---|
| `--background` / `--foreground` | `bg-background` / `text-foreground` | page/app background and default text |
| `--popover` / `--popover-foreground` | `bg-popover` / `text-popover-foreground` | dropdowns, dialogs, tooltips |
| `--primary` / `--primary-foreground` | `bg-primary` / `text-primary-foreground` | primary actions |
| `--secondary` / `--secondary-foreground` | `bg-secondary` / `text-secondary-foreground` | secondary surfaces (e.g. user chat bubbles) |
| `--muted` / `--muted-foreground` | `bg-muted` / `text-muted-foreground` | de-emphasized text, subtle fills |
| `--accent` | `bg-accent` | hover/active states |
| `--destructive` | `bg-destructive` / `text-destructive` | errors, delete actions |
| `--brand` | `bg-brand` / `text-brand` | Hoy's accent color (links, active selection, `$` prompts) |
| `--border` / `--input` | `border-border` / `border-input` | borders |
| `--sidebar` / `--sidebar-foreground` | `bg-sidebar` / `text-sidebar-foreground` | sidebar-specific surface (separate from page background) |
| `--radius` | `rounded-sm` / `rounded-md` / `rounded-lg` / `rounded-xl` (scaled off `--radius`) | corner radius — `rounded-lg` is the default control radius |
| `--font-sans` | default body font (Geist Variable) | do not set a competing `font-family` |
| `--font-mono` | `font-mono` | code, terminal output, numeric/context-size labels |

**Important constraint:** `styles.css` is a static snapshot of the Tailwind utilities this app currently happens to use, not a live compiler — only classes already present in the stylesheet render. The table above is verified against the shipped CSS. For a token you need that has no verified utility yet (e.g. a `card`/`ring`/`accent-foreground`/`brand-foreground` surface), style it directly with the CSS variable instead of guessing a utility class name: `style={{ backgroundColor: "var(--card)", color: "var(--card-foreground)" }}`. This always works since the variables themselves are defined for every token, even where a matching utility class wasn't generated.

Spacing and layout are plain Tailwind (`gap-2`, `px-3`, `text-sm`, `text-xs`) — there is no custom spacing scale. Buttons/badges carry their own `variant`/`size` props (see each component's `.d.ts`) — never hand-roll button colors with raw utility classes.

## Where the truth lives

Read `styles.css` (and its `@import` of `_ds_bundle.css`) for the full token list before styling anything — it is the actual compiled stylesheet, not a summary. Each component's `<Name>.d.ts` is its real prop contract (variant/size enums, required vs optional props); each `<Name>.prompt.md` shows real composition.

## Building with it

A typical assistant-chat composition (real pattern from this app's own `ThreadView`):

```jsx
<Conversation className="h-full w-full">
  <ConversationContent className="gap-4 px-3 py-3">
    <Message from="user">
      <MessageContent>How do I rebuild the sidecar binary?</MessageContent>
    </Message>
    <Message from="assistant">
      <MessageContent>
        <MessageResponse>
          {"Run `sidecar/build.sh` whenever `sidecar/pi-src` changes."}
        </MessageResponse>
      </MessageContent>
    </Message>
  </ConversationContent>
  <ConversationScrollButton />
</Conversation>
```

For your own layout glue (panels, toolbars, headers) use the token table above — e.g. a toolbar is `flex items-center gap-2 border-b border-border bg-background px-3 py-2`, not a custom color.
