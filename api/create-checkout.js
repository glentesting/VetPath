// Environment variables needed:
// STRIPE_SECRET_KEY — from Stripe dashboard > Developers > API keys
// STRIPE_PRICE_ID — create a product in Stripe, then copy the price ID (price_xxx)

import Stripe from 'stripe';

export const config = { runtime: 'edge' };

export default async function handler(req) {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  const authHeader = req.headers.get('authorization');
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return new Response(JSON.stringify({ error: 'Please log in to upgrade.' }), {
      status: 401, headers: { 'Content-Type': 'application/json' }
    });
  }

  try {
    const { userId, userEmail } = await req.json();

    if (!userId || !userEmail) {
      return new Response(JSON.stringify({ error: 'User information is required.' }), {
        status: 400, headers: { 'Content-Type': 'application/json' }
      });
    }

    const stripe = new Stripe(process.env.STRIPE_SECRET_KEY, {
      apiVersion: '2024-06-20'
    });

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      payment_method_types: ['card'],
      customer_email: userEmail,
      line_items: [{
        price: process.env.STRIPE_PRICE_ID,
        quantity: 1
      }],
      success_url: 'https://www.underratedvets.com/dashboard.html?upgraded=true',
      cancel_url: 'https://www.underratedvets.com/upgrade.html',
      metadata: {
        supabase_user_id: userId
      },
      subscription_data: {
        metadata: {
          supabase_user_id: userId
        }
      }
    });

    return new Response(JSON.stringify({ success: true, url: session.url }), {
      status: 200, headers: { 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: 'Could not create checkout session \u2014 please try again. If this keeps happening, email support@underratedvets.com.' }), {
      status: 500, headers: { 'Content-Type': 'application/json' }
    });
  }
}
