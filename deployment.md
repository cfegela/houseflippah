### Step 1: Apply Pre-Deployment Security Hardening Locally
Before deploying, I can create and apply migration `20261104000013_production_security_hardening.sql` and update [`frontend/.gitignore`](file:///Users/chrisfegela/git/cfeg/houseflippah/frontend/.gitignore) to lock down all table write permissions, function grants, and price caps.

### Step 2: Create & Configure Supabase Cloud Project
1. Sign in to [supabase.com/dashboard](https://supabase.com/dashboard) and click **New Project**.
2. Choose an organization, name it `houseflippah`, set a strong database password, and select a region close to your players (e.g., `us-east-1`).
3. Once provisioned, go to **Authentication → Providers → Anonymous Sign-Ins** and toggle **Enable Anonymous Sign-Ins** to **ON**.
4. Go to **Authentication → Rate Limits** and verify **Anonymous Sign-Ins** rate limit is set (default `30` per hour per IP; you can raise to `60` if multiple playtesters share the same Wi-Fi/office IP).
5. Link and push your local migrations from your terminal:
   ```bash
   npx supabase login
   npx supabase link --project-ref <your-supabase-project-ref>
   npx supabase db push
   ```
6. Copy your **Project URL** and **`anon` `public` API Key** from **Project Settings → API**.

### Step 3: Deploy Frontend to Cloudflare Pages
1. Log in to [dash.cloudflare.com](https://dash.cloudflare.com) and go to **Workers & Pages → Create → Pages → Connect to Git**.
2. Select your GitHub repository: `cfegela/houseflippah`.
3. Configure the build settings:
   - **Production branch**: `main`
   - **Root directory**: `frontend`
   - **Framework preset**: `Vite`
   - **Build command**: `npm run build`
   - **Build output directory**: `dist`
4. Expand **Environment variables (production & preview)** and add:
   - `VITE_SUPABASE_URL` = `https://<your-project-ref>.supabase.co`
   - `VITE_SUPABASE_ANON_KEY` = `<your-supabase-anon-public-key>`
5. Click **Save and Deploy**. Within ~30 seconds, your game will be live at `https://houseflippah.pages.dev` (or your custom domain)!

### Step 4: Finalize Supabase Site URL
1. In your Supabase Dashboard, go to **Authentication → URL Configuration**.
2. Set **Site URL** to your live Cloudflare Pages URL (e.g., `https://houseflippah.pages.dev`).
3. Add `https://*.houseflippah.pages.dev` to **Redirect URLs** for preview deployments.
