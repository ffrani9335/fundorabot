const axios = require('axios');
const express = require('express');
const bodyParser = require('body-parser');

// --- ⚙️ CONFIGURATION (Your details are already here) ---
const BOT_TOKEN = '8114710727:AAFb76pLg6QhHed3JB0WyHXQcsbpDJXVq4U';
const ADMIN_CHAT_ID = '7972815378'; // Your correct numeric Admin ID

const UPI_ID = 'fundora@kiwi';
const BOT_USERNAME = 'fundoraxbot';
const SUPPORT_USERNAME = 'fundoraagent';
const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;
const WEBHOOK_URL = `https://funderabot.onrender.com/webhook`; // Your Render URL

// --- 💾 IN-MEMORY DATABASE ---
let users = {};
let pending_payments = {};
let pending_withdrawals = {};
let investments = [];

// --- 🤖 TELEGRAM HELPER FUNCTIONS ---
async function sendMessage(chat_id, text, opts = {}) {
  try {
    await axios.post(`${API_URL}/sendMessage`, { chat_id, text, parse_mode: 'Markdown', ...opts });
  } catch (error) {
    console.error(`Error sending message to ${chat_id}:`, error.response ? error.response.data : error.message);
  }
}

async function sendPhoto(chat_id, photo, caption, opts = {}) {
  try {
    await axios.post(`${API_URL}/sendPhoto`, { chat_id, photo, caption, parse_mode: 'Markdown', ...opts });
  } catch (error) {
    console.error(`Error sending photo to ${chat_id}:`, error.response ? error.response.data : error.message);
  }
}

// ---  MAIN BOT LOGIC ---
async function handleUpdate(body) {
  const message = body.message || (body.callback_query && body.callback_query.message);
  if (!message) {
    console.log("Received a non-message update, skipping.");
    return;
  }

  const chat_id = message.chat.id.toString(); // Use string for consistency
  const user_id = chat_id;
  const text = (message.text || '').trim();
  const photo = message.photo;
  const is_admin = (chat_id === ADMIN_CHAT_ID);

  if (!users[user_id]) {
    users[user_id] = {
      id: user_id, name: message.chat.first_name || 'User', wallet_balance: 0,
      referral_earning: 0, total_withdrawn: 0, active_investments: 0,
      referral_code: `FND${user_id}`, referred_by: null, state: null, state_data: {}
    };
  }
  const user = users[user_id];

  // --- STATE-BASED INPUT (Handles multi-step actions like payments) ---
  if (user.state) {
    switch (user.state) {
      case 'awaiting_utr':
        if (text && text.match(/^\d{10,18}$/)) {
            pending_payments[user_id].utr = text;
            user.state = 'awaiting_screenshot';
            await sendMessage(chat_id, '✅ UTR received.\n\nNow, please upload the payment screenshot.');
        } else {
            await sendMessage(chat_id, '❌ Invalid UTR. Please send a valid UPI Transaction ID (usually 12 digits).');
        }
        return;
      case 'awaiting_screenshot':
        if (photo) {
            const file_id = photo[photo.length - 1].file_id;
            pending_payments[user_id].screenshot_file_id = file_id;
            user.state = null;
            const pending = pending_payments[user_id];
            await sendMessage(chat_id, '🕒 Thank you! Your payment is submitted and is now pending approval.');
            const adminCaption = `🆕 New Payment Pending\n\n*User:* ${user.name} (\`${user_id}\`)\n*Plan:* ${pending.plan.plan_name}\n*Amount:* ₹${pending.amount}\n*UTR:* \`${pending.utr}\`\n\nApprove: /approve_${user_id}\nReject: /reject_${user_id}`;
            await sendPhoto(ADMIN_CHAT_ID, file_id, adminCaption);
        } else {
            await sendMessage(chat_id, '❌ That\'s not a photo. Please upload your payment screenshot.');
        }
        return;
      // ... other states for withdrawal ...
    }
    // If we are in a state, we stop further command processing
    return;
  }

  // --- COMMAND AND TEXT HANDLERS ---
  const lowerCaseText = text.toLowerCase();

  // FIX: Handle "invest 1" and "1" as replies to /invest
  if (lowerCaseText.startsWith('invest ') || lowerCaseText.match(/^[12]$/)) {
      let planId = lowerCaseText.replace('invest ', '');
      if (!['1', '2'].includes(planId)) {
        // Fallback for unknown commands
      } else {
        const plan = planId === '1'
            ? { plan_name: 'Fundora Industry', amount: 100, return_amount: 150, duration: 45 }
            : { plan_name: 'Fundora Space', amount: 200, return_amount: 400, duration: 90 };
        
        const upiLink = `upi://pay?pa=${UPI_ID}&pn=Fundora&am=${plan.amount}&cu=INR&tn=Fundora_Investment`;
        const caption = `Tap to copy the UPI ID or use the link to pay ₹${plan.amount}.\n\n*UPI ID:* \`${UPI_ID}\`\n\n[Pay ₹${plan.amount} via UPI](${upiLink})`;
        await sendMessage(chat_id, caption);
        
        pending_payments[user_id] = { amount: plan.amount, plan: plan };
        user.state = 'awaiting_utr';
        await sendMessage(chat_id, 'After paying, please reply with the *UPI Transaction ID (UTR)*.');
        return; // Important: Stop processing after this
      }
  }
  
  // --- ADMIN COMMANDS ---
  if (is_admin) {
      if (lowerCaseText.startsWith('/approve_')) {
          const id = text.split('_')[1];
          const p = pending_payments[id];
          if (!p) { await sendMessage(ADMIN_CHAT_ID, `No pending payment for ${id}.`); return; }
          investments.push({ id: investments.length + 1, user_id: id, status: 'active', ...p.plan, start_date: new Date(), end_date: new Date(Date.now() + p.plan.duration * 24 * 60 * 60 * 1000) });
          const u = users[id]; u.active_investments += 1;
          if (u.referred_by && u.active_investments === 1) {
              const r = Object.values(users).find(usr => usr.referral_code === u.referred_by);
              if (r) { r.referral_earning += 20; r.wallet_balance += 20; await sendMessage(r.id, `🎉 You received ₹20 bonus as ${u.name} invested!`); }
          }
          await sendMessage(id, `✅ Your investment is approved!\n*Plan:* ${p.plan.plan_name}\n*Amount:* ₹${p.amount}`);
          await sendMessage(ADMIN_CHAT_ID, `✅ Approved investment for ${id}.`);
          delete pending_payments[id];
          return;
      }
      if (lowerCaseText.startsWith('/reject_')) {
          const id = text.split('_')[1];
          if (pending_payments[id]) {
              delete pending_payments[id];
              await sendMessage(id, '❌ Your payment was rejected. Contact support.');
              await sendMessage(ADMIN_CHAT_ID, `❌ Rejected payment for ${id}.`);
          }
          return;
      }
      // ... other admin commands for withdrawal ...
  }

  // --- REGULAR USER COMMANDS ---
  switch (lowerCaseText) {
    case '/start':
      const refCode = text.split(' ')[1] || null;
      if (refCode && !user.referred_by && refCode !== user.referral_code) {
        user.referred_by = refCode;
        await sendMessage(chat_id, `You were referred by user ${refCode}.`);
      }
      await sendMessage(chat_id, `👋 Welcome to Fundora, ${user.name}!\n\n/invest - Start an investment\n/wallet - Check your balance\n/withdraw - Withdraw earnings\n/refer - Get referral link\n/support - Contact support`);
      break;
    case '/invest':
      await sendMessage(chat_id, `Choose a plan by replying with \`1\` or \`2\`:\n\n*1. Fundora Industry*\n> Invest: ₹100, Return: 50% in 45 days\n\n*2. Fundora Space*\n> Invest: ₹200, Return: 100% in 90 days`);
      break;
    case '/wallet':
      await sendMessage(chat_id, `*Wallet* 🏦\n\nBalance: ₹${user.wallet_balance.toFixed(2)}\nReferral Earning: ₹${user.referral_earning.toFixed(2)}\nTotal Withdrawn: ₹${user.total_withdrawn.toFixed(2)}`);
      break;
    case '/withdraw':
        if (user.wallet_balance < 50) {
            await sendMessage(chat_id, '❌ Minimum ₹50 required to withdraw.');
        } else {
            // Add withdrawal logic here
            await sendMessage(chat_id, "Withdrawal feature coming soon!");
        }
        break;
    case '/refer':
      await sendMessage(chat_id, `Your referral link:\nhttps://t.me/${BOT_USERNAME}?start=${user.referral_code}\n\n*Total Referral Earnings:* ₹${user.referral_earning}`);
      break;
    case '/support':
      await sendMessage(chat_id, `For help, contact support: @${SUPPORT_USERNAME}`);
      break;
    default:
        // This will catch commands that are not defined, like when you sent "1" from the admin account.
        // If the user is an admin and the command isn't an admin command, we do nothing.
        // If the user is not an admin, we tell them it's an unknown command.
        if (!is_admin) {
            await sendMessage(chat_id, 'Sorry, I don\'t understand that command. Use /start to see the options.');
        }
  }
}

// --- EXPRESS SERVER FOR WEBHOOK ---
const app = express();
app.use(bodyParser.json());

app.post(`/webhook`, async (req, res) => {
  try {
    await handleUpdate(req.body);
  } catch (error) {
    console.error('FATAL ERROR in handleUpdate:', error);
  }
  res.status(200).send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Bot server running on port ${PORT}`);
  try {
    if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
        console.error("FATAL: BOT_TOKEN or ADMIN_CHAT_ID is missing.");
        return;
    }
    const response = await axios.get(`${API_URL}/setWebhook?url=${WEBHOOK_URL}`);
    console.log(`Webhook set successfully to: ${WEBHOOK_URL}`);
  } catch (e) {
    console.error('Error setting webhook:', e.response ? e.response.data : e.message);
  }
});
