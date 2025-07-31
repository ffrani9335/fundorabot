const axios = require('axios');
const QRCode = require('qrcode');
const express = require('express');
const bodyParser = require('body-parser');

const BOT_TOKEN = '8114710727:AAFb76pLg6QhHed3JB0WyHXQcsbpDJXVq4U';
const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;
const UPI_ID = 'fundora@kiwi';
const ADMIN_CHAT_ID = 'YOUR_ADMIN_CHAT_ID'; // Replace with your Telegram user ID

let users = {};
let investments = [];
let withdrawals = [];
let referrals = [];
let pending_payments = {}; // user_id: {amount, plan, step, utr, screenshot_file_id}

async function sendMessage(chat_id, text, opts = {}) {
  await axios.post(`${API_URL}/sendMessage`, { chat_id, text, ...opts });
}

async function sendPhoto(chat_id, photo, caption) {
  await axios.post(`${API_URL}/sendPhoto`, { chat_id, photo, caption });
}

function getUPILink(amount, note = 'Fundora Investment') {
  return `upi://pay?pa=${UPI_ID}&pn=Fundora&am=${amount}&cu=INR&tn=${encodeURIComponent(note)}`;
}

async function sendUPIQR(chat_id, amount) {
  const upiLink = getUPILink(amount);
  const qr = await QRCode.toDataURL(upiLink);
  await sendPhoto(chat_id, qr, `Scan to pay ₹${amount} to Fundora\nUPI ID: ${UPI_ID}\n[Pay Now](${upiLink})`);
}

async function handleUpdate(body) {
  if (!body.message) return;

  const chat_id = body.message.chat.id;
  const text = (body.message.text || '').trim();
  const user_id = chat_id;

  // Register user if not exists
  if (!users[user_id]) {
    users[user_id] = {
      id: user_id,
      name: body.message.from.first_name,
      wallet_balance: 0,
      referral_earning: 0,
      total_withdrawn: 0,
      active_investments: 0,
      level: 0,
      referral_code: `FND${user_id}`,
      referred_by: null
    };
  }

  // If user is in payment process (waiting for UTR or screenshot)
  if (pending_payments[user_id]) {
    let pending = pending_payments[user_id];

    // Step 1: Waiting for UTR
    if (pending.step === 1 && text.match(/^\d{10,}$/)) {
      pending.utr = text;
      pending.step = 2;
      await sendMessage(chat_id, '✅ UTR received.\nNow, please upload the payment screenshot.');
      return;
    }

    // Step 2: Waiting for screenshot
    if (pending.step === 2 && body.message.photo) {
      // Get the largest photo file_id
      const photoArray = body.message.photo;
      const file_id = photoArray[photoArray.length - 1].file_id;
      pending.screenshot_file_id = file_id;
      pending.step = 3;

      // Notify admin for approval
      await sendMessage(chat_id, '🕒 Payment details submitted. Waiting for admin approval.');
      await sendPhoto(
        ADMIN_CHAT_ID,
        file_id,
        `🆕 New Payment Pending Approval\nUser: ${users[user_id].name} (${user_id})\nPlan: ${pending.plan.plan_name}\nAmount: ₹${pending.amount}\nUTR: ${pending.utr}\n\nApprove: /approve_${user_id}`
      );
      return;
    }
  }

  // Command Handlers
  if (text.startsWith('/start')) {
    let ref = text.split(' ')[1] || null;
    if (ref && !users[user_id].referred_by && ref !== users[user_id].referral_code) {
      users[user_id].referred_by = ref;
      referrals.push({ from_user: ref, to_user: user_id, commission: 20, created_at: new Date() });
      // Credit referral after first investment
    }
    await sendMessage(chat_id, `👋 Welcome to Fundora!\nYour referral code: ${users[user_id].referral_code}\nUse /invest to start.`);
  }

  else if (text === '/wallet') {
    let u = users[user_id];
    await sendMessage(chat_id, `💰 Wallet: ₹${u.wallet_balance}\nReferral: ₹${u.referral_earning}\nWithdrawn: ₹${u.total_withdrawn}\nActive Investments: ${u.active_investments}`);
  }

  else if (text === '/invest') {
    await sendMessage(chat_id, `Choose a plan:\n1. Fundora Industry: ₹100, 50% in 45 days\n2. Fundora Space: ₹200, 100% in 90 days\n\nReply: invest 1 or invest 2`);
  }

  else if (text.startsWith('invest')) {
    let plan = text.split(' ')[1];
    let planObj = plan === '1'
      ? { plan_name: 'Fundora Industry', amount: 100, return_amount: 150, duration: 45 }
      : { plan_name: 'Fundora Space', amount: 200, return_amount: 400, duration: 90 };
    // Send UPI QR and link
    await sendUPIQR(chat_id, planObj.amount);
    await sendMessage(chat_id, `After payment, reply: paid ${planObj.amount}`);
    // Save pending investment
    users[user_id].pending_investment = planObj;
  }

  else if (text.startsWith('paid')) {
    let amt = parseInt(text.split(' ')[1]);
    let planObj = users[user_id].pending_investment;
    if (!planObj || planObj.amount !== amt) {
      await sendMessage(chat_id, 'No matching pending investment. Use /invest to start.');
      return;
    }
    // Start payment verification process
    pending_payments[user_id] = {
      amount: amt,
      plan: planObj,
      step: 1, // 1: waiting for UTR, 2: waiting for screenshot, 3: waiting for admin
      utr: null,
      screenshot_file_id: null
    };
    await sendMessage(chat_id, 'Please enter your UPI Transaction ID (UTR).');
  }

  else if (text === '/myorders') {
    let myInv = investments.filter(i => i.user_id === user_id);
    if (!myInv.length) return await sendMessage(chat_id, 'No active investments.');
    let msg = myInv.map(i => `${i.plan_name}: ₹${i.amount}, Ends: ${i.end_date.toDateString()}`).join('\n');
    await sendMessage(chat_id, msg);
  }

  else if (text === '/withdraw') {
    let u = users[user_id];
    if (u.wallet_balance < 50) return await sendMessage(chat_id, 'Minimum ₹50 required to withdraw.');
    let withdraw_amount = u.wallet_balance;
    let reinvest_amount = Math.floor(withdraw_amount * 0.5);
    let transfer_amount = withdraw_amount - reinvest_amount;

    // Force reinvest
    investments.push({
      id: investments.length + 1,
      user_id,
      plan_name: 'Auto Reinvest',
      amount: reinvest_amount,
      return_amount: reinvest_amount * 1.5,
      duration: 45,
      status: 'active',
      start_date: new Date(),
      end_date: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000)
    });
    u.wallet_balance = 0;
    u.total_withdrawn += transfer_amount;
    u.level += 1;

    withdrawals.push({
      id: withdrawals.length + 1,
      user_id,
      amount: transfer_amount,
      upi_sent: false,
      reinvested_amount: reinvest_amount,
      date: new Date(),
      status: 'pending'
    });

    await sendMessage(chat_id, `✅ Withdraw request: ₹${transfer_amount} (to UPI)\n₹${reinvest_amount} auto-reinvested.\nLevel: ${u.level}`);
  }

  else if (text === '/refer') {
    await sendMessage(chat_id, `Invite link: https://t.me/FundoraInvestmentBot?start=${users[user_id].referral_code}\nEarnings: ₹${users[user_id].referral_earning}`);
  }

  else if (text === '/support') {
    await sendMessage(chat_id, 'Contact admin: @youradminusername');
  }

  // Admin approval command
  else if (text.startsWith('/approve_') && chat_id.toString() === ADMIN_CHAT_ID) {
    let approve_user_id = text.split('_')[1];
    let pending = pending_payments[approve_user_id];
    if (!pending) {
      await sendMessage(chat_id, 'No pending payment for this user.');
      return;
    }
    // Approve investment
    investments.push({
      id: investments.length + 1,
      user_id: approve_user_id,
      ...pending.plan,
      status: 'active',
      start_date: new Date(),
      end_date: new Date(Date.now() + pending.plan.duration * 24 * 60 * 60 * 1000)
    });
    users[approve_user_id].active_investments += 1;
    users[approve_user_id].pending_investment = null;
    // Credit referral if first investment
    if (users[approve_user_id].referred_by) {
      let refUser = Object.values(users).find(u => u.referral_code === users[approve_user_id].referred_by);
      if (refUser) refUser.referral_earning += 20;
    }
    await sendMessage(approve_user_id, `✅ Your investment is approved!\nPlan: ${pending.plan.plan_name}\nAmount: ₹${pending.amount}\nReturn: ₹${pending.plan.return_amount} in ${pending.plan.duration} days.`);
    await sendMessage(chat_id, `Approved investment for user ${approve_user_id}.`);
    delete pending_payments[approve_user_id];
  }

  else {
    await sendMessage(chat_id, 'Unknown command. Use /invest, /wallet, /withdraw, /refer');
  }
}

// Express server for webhook
const app = express();
app.use(bodyParser.json());

app.post('/webhook', async (req, res) => {
  await handleUpdate(req.body);
  res.send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log('Bot server running on port', PORT);
});