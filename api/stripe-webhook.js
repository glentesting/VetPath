// Environment variables needed:
// STRIPE_SECRET_KEY — from Stripe dashboard > Developers > API keys
// STRIPE_WEBHOOK_SECRET — from Stripe dashboard > Developers > Webhooks > signing secret
// SUPABASE_SERVICE_ROLE_KEY — from Supabase dashboard > Settings > API > service_role key
//
// STRIPE WEBHOOK SETUP REQUIRED:
// Dashboard → Developers → Webhooks → Add endpoint
// URL: https://underratedvets.com/api/stripe-webhook
// Events to listen for:
//   - checkout.session.completed
//   - customer.subscription.deleted
// After creating, copy the Signing Secret → STRIPE_WEBHOOK_SECRET in Vercel

import Stripe from 'stripe';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
    apiVersion: '2024-06-20'
  });

  const body = await req.text();
  const sig = req.headers.get('stripe-signature');

  let event;
  try {
    // Verify webhook signature
    event = await stripe.webhooks.constructEventAsync(
      body,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return new Response(JSON.stringify({ error: 'Invalid signature' }), {
      status: 400, headers: { 'Content-Type': 'application/json' }
    });
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userEmail = session.customer_email;
    const userId = session.metadata?.supabase_user_id;

    if (!userEmail && !userId) {
      console.error('No user identifier in checkout session');
      return new Response(JSON.stringify({ received: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    const SUPABASE_URL = 'https://bglhfmwjfnmybcrjlscm.supabase.co';
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    try {
      // If we have userId from metadata, update directly
      if (userId) {
        await fetch(`${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${userId}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({ plan: 'pro' })
        });
      } else {
        // Fallback: look up user by email in auth.users, then update profiles
        const usersRes = await fetch(`${SUPABASE_URL}/auth/v1/admin/users?filter=email%3D${encodeURIComponent(userEmail)}`, {
          headers: {
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`
          }
        });
        const usersData = await usersRes.json();
        const user = usersData?.users?.[0];

        if (user) {
          // Upsert profile with pro plan
          await fetch(`${SUPABASE_URL}/rest/v1/profiles`, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'apikey': SUPABASE_KEY,
              'Authorization': `Bearer ${SUPABASE_KEY}`,
              'Prefer': 'resolution=merge-duplicates'
            },
            body: JSON.stringify({ user_id: user.id, plan: 'pro' })
          });
        }
      }
    } catch (err) {
      console.error('Failed to update user plan:', err);
    }
  }

  // Handle subscription cancellation
  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const userId = subscription.metadata?.supabase_user_id;

    if (userId) {
      const SUPABASE_URL = 'https://bglhfmwjfnmybcrjlscm.supabase.co';
      const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

      try {
        await fetch(`${SUPABASE_URL}/rest/v1/profiles?user_id=eq.${userId}`, {
          method: 'PATCH',
          headers: {
            'Content-Type': 'application/json',
            'apikey': SUPABASE_KEY,
            'Authorization': `Bearer ${SUPABASE_KEY}`,
            'Prefer': 'return=minimal'
          },
          body: JSON.stringify({ plan: 'free' })
        });
      } catch (err) {
        console.error('Failed to downgrade user plan:', err);
      }
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
}
