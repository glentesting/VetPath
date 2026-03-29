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
import { createClient } from '@supabase/supabase-js';

export const config = { runtime: 'edge' };

const SUPABASE_URL = 'https://bglhfmwjfnmybcrjlscm.supabase.co';

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

  console.log('Stripe webhook received:', event.type);

  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!SUPABASE_KEY) {
    console.error('SUPABASE_SERVICE_ROLE_KEY is not set');
    return new Response(JSON.stringify({ received: true, error: 'Missing service role key' }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });
  }

  const adminClient = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false }
  });

  // ── CHECKOUT COMPLETED — set plan to 'earned' ──
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const userEmail = session.customer_email;
    const userId = session.metadata?.supabase_user_id;

    console.log('Checkout completed — email:', userEmail, 'userId from metadata:', userId);

    if (!userEmail && !userId) {
      console.error('No user identifier in checkout session — cannot update plan');
      return new Response(JSON.stringify({ received: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    let targetUserId = userId;

    // If no userId in metadata, look up by email
    if (!targetUserId && userEmail) {
      console.log('No userId in metadata, looking up by email:', userEmail);
      try {
        const { data: { users }, error: listErr } = await adminClient.auth.admin.listUsers();
        if (listErr) {
          console.error('Failed to list users:', listErr.message);
        } else {
          const match = users.find(u => u.email === userEmail);
          if (match) {
            targetUserId = match.id;
            console.log('Found user by email, id:', targetUserId);
          } else {
            console.error('No user found with email:', userEmail, '— searched', users.length, 'users');
          }
        }
      } catch (e) {
        console.error('Exception looking up user by email:', e.message);
      }
    }

    if (!targetUserId) {
      console.error('Could not resolve user ID — plan NOT updated');
      return new Response(JSON.stringify({ received: true }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    }

    // Upsert profile with plan = 'earned'
    console.log('Setting plan to earned for user:', targetUserId);
    const { error: upsertErr } = await adminClient
      .from('profiles')
      .upsert({ user_id: targetUserId, plan: 'earned' }, { onConflict: 'user_id' });

    if (upsertErr) {
      console.error('FAILED to upsert plan:', upsertErr.message, upsertErr.details, upsertErr.hint);
    } else {
      console.log('SUCCESS — plan set to earned for user:', targetUserId);
    }
  }

  // ── SUBSCRIPTION DELETED — set plan back to 'free' ──
  if (event.type === 'customer.subscription.deleted') {
    const subscription = event.data.object;
    const userId = subscription.metadata?.supabase_user_id;

    console.log('Subscription deleted — userId from metadata:', userId);

    if (userId) {
      const { error: downgradeErr } = await adminClient
        .from('profiles')
        .update({ plan: 'free' })
        .eq('user_id', userId);

      if (downgradeErr) {
        console.error('FAILED to downgrade plan:', downgradeErr.message);
      } else {
        console.log('SUCCESS — plan set to free for user:', userId);
      }
    } else {
      console.error('No userId in subscription metadata — cannot downgrade');
    }
  }

  return new Response(JSON.stringify({ received: true }), {
    status: 200, headers: { 'Content-Type': 'application/json' }
  });
}
