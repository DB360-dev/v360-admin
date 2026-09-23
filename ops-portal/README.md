# V360 Operations (Admin panel)

The internal web app for **V360** (managing partner, Lahore hub) and **KBB** (fulfilment partner in Bangladesh). Both roles use the same app; each sees only its own screens. The database enforces the same limits, so hiding a button is never the only protection.

## Who sees what

| Screen | V360 | KBB |
|---|---|---|
| Dashboard | All-brand pipeline, queues, stuck orders | "Today": calls, incoming shipments, deliveries |
| All orders + order detail | Everything, every action | View everything; KBB actions only |
| Confirmations (call customers) | ✓ | ✓ |
| Hub receiving (count parcels from brands) | ✓ | – |
| Shipments | Create, add/remove orders, set tracking, move status | See dispatched ones, **Confirm receipt** |
| Deliveries (last mile, cash collected) | ✓ | ✓ |
| Brands (approve/reject registrations) | ✓ (admins decide) | – |
| Team & access (add users, roles) | ✓ (admins edit) | – |
| FX rates, Shopify sync, Activity | ✓ | – |

**V360 admin vs operator:** operators can do all the operational work. Only admins can add or remove users and approve or reject brands.

## What each role can do to an order

**KBB:**
- **Confirmation:** start confirmation, Confirmed, Unreachable (counts attempts), Needs amendment (reason), Cancel (reason).
- **Delivery:**
  - Preparing, Out for delivery.
  - **Mark delivered**, which asks for the cash collected and requires a reason if it differs from the expected amount.
  - Delivery failed (reason), then retry or mark returned.
  - Add or edit the courier tracking number.
- **Any time:** add a note, put on hold or resume.

**V360:** everything KBB can do, plus:
- **Hub:** receive at the hub, item by item. Anything short becomes a "hub issue" the brand sees.
- **Shipments:** build them, remove an order before dispatch, and move shipment status forward. Every order inside updates automatically.
- **Orders:** edit customer details, decide what happens to returned goods, and **override** any status (the reason is required and logged).

Every button is checked by the database. If a rule blocks an action, the dialog shows the reason in plain words and keeps what you typed.

## Setup

1. **Database migrations.** Run migrations 001 to 006 in the Supabase SQL Editor, in order.
2. **User function.** Deploy it:
   ```
   supabase functions deploy manage-user
   supabase secrets set OPS_PORTAL_URL=https://ops.yourdomain.com BRAND_PORTAL_URL=https://app.yourdomain.com \
     ALLOWED_ORIGINS=https://ops.yourdomain.com,https://app.yourdomain.com,http://localhost:5173,http://localhost:5174
   ```
3. **Your admin login.** Run `supabase/setup_first_admin.sql` (edit the email first).
4. **Run the panel locally:**
   ```
   cp .env.example .env    # same Supabase URL + anon key as the brand portal
   npm install
   npm run dev             # http://localhost:5174
   ```
5. **Add KBB staff.** Go to Team & access, click Add user, choose the organization **KBB** and the role **KBB agent**, and choose "Set a password now". This works even before your email sending is set up.

## Deploy (Vercel / Netlify)

Deploy it as a separate project from the brand portal, e.g. `ops.yourdomain.com`.

- **Build command:** `npm run build`
- **Output folder:** `dist`
- **Environment variables:** `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY`

Add `https://ops.yourdomain.com/reset-password` to Supabase's **Redirect URLs**.
