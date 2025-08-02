const axios = require('axios');
const QRCode = require('qrcode');
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');

const BOT_TOKEN = '8114710727:AAFb76pLg6QhHed3JB0WyHXQcsbpDJXVq4U';
const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;
const UPI_ID = 'fundora@kiwi';
const ADMIN_CHAT_ID = 'YOUR_ADMIN_CHAT_ID'; // Replace with your Telegram user ID

let users = {};
let investments = [];
let withdrawals = [];
let referrals = [];
let pending_payments = {};
let pending_withdrawals = {};

// Generate unique referral code
function generateReferralCode() {
  return 'FND' + crypto.randomBytes(3).toString('hex').toUpperCase();
}

// Telegram API helpers
async function sendMessage(chat_id, text, opts = {}) {
  await axios.post(`${API_URL}/sendMessage`, { chat_id, text, ...opts });
}

async function sendPhoto(chat_id, photo, caption) {
  await axios.post(`${API_URL}/sendPhoto`, { chat_id, photo, caption, parse_mode: 'Markdown' });
}

function getUPILink(amount, note = 'Fundora Investment') {
  return `upi://pay?pa=${UPI_ID}&pn=Fundora&am=${amount}&cu=INR&tn=${encodeURIComponent(note)}`;
}

async function sendUPIQR(chat_id, amount) {
  const upiLink = getUPILink(amount);
  const qr = await QRCode.toDataURL(upiLink);
  await sendPhoto(chat_id, qr, `Scan to pay ₹${amount} to Fundora\nUPI ID: ${UPI_ID}\n[Pay Now](${upiLink})`);
}

// Main handler
async function handleUpdate(body) {
  if (!body.message) return;

  const chat_id = body.message.chat.id;
  const text = (body.message.text || '').trim().toLowerCase();
  const user_id = chat_id;

  // Register user
  if (!users[user_id]) {
    users[user_id] = {
      id: user_id,
      name: body.message.from.first_name,
      wallet_balance: 0,
      referral_earning: 0,
      total_withdrawn: 0,
      active_investments: 0,
      level: 0,
      referral_code: generateReferralCode(),
      referred_by: null,
      withdraw_method: null,
      withdraw_details: {}
    };
  }

  const user = users[user_id];

  // Handle pending payment
  if (pending_payments[user_id]) {
    const pending = pending_payments[user_id];

    if (pending.step === 1 && text.match(/^\d{10,}$/)) {
      pending.utr = text;
      pending.step = 2;
      await sendMessage(chat_id, '✅ UTR received.\nNow, please upload the payment screenshot.');
      return;
    }

    if (pending.step === 2 && body.message.photo) {
      const photoArray = body.message.photo;
      const file_id = photoArray[photoArray.length - 1].file_id;
      pending.screenshot_file_id = file_id;
      pending.step = 3;

      await sendMessage(chat_id, '🕒 Payment details submitted. Waiting for admin approval.');
      await sendPhoto(
        ADMIN_CHAT_ID,
        file_id,
        `🔔 New Payment Request\nUser: ${user.name} (${user_id})\nPlan: ${pending.plan.plan_name}\nAmount: ₹${pending.amount}\nUTR: ${pending.utr}\n\n✅ Approve: /approve_${user_id}\n❌ Reject: /reject_${user_id}`
      );
      return;
    }
  }

  // Handle pending withdrawal
  if (user.withdraw_method && !user.withdraw_details.complete) {
    if (user.withdraw_method === 'upi') {
      if (!user.withdraw_details.upi_id) {
        user.withdraw_details.upi_id = text;
        await sendMessage(chat_id, 'Enter UPI Name:');
        return;
      }
      if (!user.withdraw_details.upi_name) {
        user.withdraw_details.upi_name = text;
        user.withdraw_details.complete = true;
        await sendMessage(chat_id, '✅ Withdrawal request submitted. Admin will process it soon.');
        pending_withdrawals[user_id] = {
          amount: user.wallet_balance,
          method: 'upi',
          details: user.withdraw_details,
          status: 'pending'
        };
        await sendMessage(
          ADMIN_CHAT_ID,
          `💸 Withdrawal Request\nUser: ${user.name} (${user_id})\nAmount: ₹${user.wallet_balance}\nMethod: UPI\nUPI ID: ${user.withdraw_details.upi_id}\nName: ${user.withdraw_details.upi_name}\n\n✅ Approve: /withdraw_approve_${user_id}\n❌ Reject: /withdraw_reject_${user_id}`
        );
        user.wallet_balance = 0;
        user.withdraw_method = null;
        user.withdraw_details = {};
        return;
      }
    }

    if (user.withdraw_method === 'bank') {
      if (!user.withdraw_details.account_no) {
        user.withdraw_details.account_no = text;
        await sendMessage(chat_id, 'Enter IFSC Code:');
        return;
      }
      if (!user.withdraw_details.ifsc) {
        user.withdraw_details.ifsc = text;
        await sendMessage(chat_id, 'Enter Account Holder Name:');
        return;
      }
      if (!user.withdraw_details.name) {
        user.withdraw_details.name = text;
        user.withdraw_details.complete = true;
        await sendMessage(chat_id, '✅ Withdrawal request submitted. Admin will process it soon.');
        pending_withdrawals[user_id] = {
          amount: user.wallet_balance,
          method: 'bank',
          details: user.withdraw_details,
          status: 'pending'
        };
        await sendMessage(
          ADMIN_CHAT_ID,
          `💸 Withdrawal Request\nUser: ${user.name} (${user_id})\nAmount: ₹${user.wallet_balance}\nMethod: Bank\nAccount: ${user.withdraw_details.account_no}\nIFSC: ${user.withdraw_details.ifsc}\nName: ${user.withdraw_details.name}\n\n✅ Approve: /withdraw_approve_${user_id}\n❌ Reject: /withdraw_reject_${user_id}`
        );
        user.wallet_balance = 0;
        user.withdraw_method = null;
        user.withdraw_details = {};
        return;
      }
    }
  }

  // Command handlers
  if (text.startsWith('/start')) {
    const ref = text.split(' ')[1] || null;
    if (ref && !user.referred_by && ref !== user.referral_code) {
      user.referred_by = ref;
      referrals.push({ from_user: ref, to_user: user_id, commission: 20, created_at: new Date() });
    }
    await sendMessage(chat_id, `👋 Welcome to Fundora!\nYour referral code: ${user.referral_code}\nUse /invest to start.`);
  }

  else if (text === '/wallet') {
    await sendMessage(chat_id, `💰 Wallet: ₹${user.wallet_balance}\nReferral: ₹${user.referral_earning}\nWithdrawn: ₹${user.total_withdrawn}\nActive Investments: ${user.active_investments}`);
  }

  else if (text === '/invest') {
    await sendMessage(chat_id, `Choose a plan:\n1. Fundora Industry: ₹100, 50% in 45 days\n2. Fundora Space: ₹200, 100% in 90 days\n\nReply: invest 1 or invest 2`);
  }

  else if (text.startsWith('invest')) {
    const plan = text.split(' ')[1];
    const planObj = plan === '1'
      ? { plan_name: 'Fundora Industry', amount: 100, return_amount: 150, duration: 45 }
      : { plan_name: 'Fundora Space', amount: 200, return_amount: 400, duration: 90 };

    if (!planObj) return await sendMessage(chat_id, 'Invalid plan. Use /invest to see options.');

    await sendUPIQR(chat_id, planObj.amount);
    await sendMessage(chat_id, `After payment, reply: paid ${planObj.amount}`);
    user.pending_investment = planObj;
  }

  else if (text.startsWith('paid')) {
    const amt = parseInt(text.split(' ')[1]);
    const planObj = user.pending_investment;
    if (!planObj || planObj.amount !== amt) {
      return await sendMessage(chat_id, 'No matching pending investment. Use /invest to start.');
    }
    pending_payments[user_id] = {
      amount: amt,
      plan: planObj,
      step: 1,
      utr: null,
      screenshot_file_id: null
    };
    await sendMessage(chat_id, 'Please enter your UPI Transaction ID (UTR).');
  }

  else if (text === '/myorders') {
    const myInv = investments.filter(i => i.user_id === user_id);
    if (!myInv.length) return await sendMessage(chat_id, 'No active investments.');
    const msg = myInv.map(i => `${i.plan_name}: ₹${i.amount}, Ends: ${i.end_date.toDateString()}`).join('\n');
    await sendMessage(chat_id, msg);
  }

  else if (text === '/withdraw') {
    if (user.wallet_balance < 50) return await sendMessage(chat_id, 'Minimum ₹50 required to withdraw.');
    await sendMessage(chat_id, 'Withdraw via UPI or Bank?\nReply: upi or bank');
    user.withdraw_method = null;
    user.withdraw_details = {};
  }

  else if (text === 'upi' || text === 'bank') {
    user.withdraw_method = text;
    if (text === 'upi') {
      await sendMessage(chat_id, 'Enter UPI ID:');
    } else {
      await sendMessage(chat_id, 'Enter Bank Account Number:');
    }
  }

  else if (text === '/refer') {
    await sendMessage(chat_id, `Invite link: https://t.me/fundoraxbot?start=${user.referral_code}\nEarnings: ₹${user.referral_earning}`);
  }

  else if (text === '/support') {
    await sendMessage(chat_id, 'For support, contact: @chieffundora');
  }

  // Admin commands
  else if (text.startsWith('/approve_') && chat_id.toString() === ADMIN_CHAT_ID) {
    const uid = text.split('_')[1];
    const pending = pending_payments[uid];
    if (!pending) return await sendMessage(chat_id, 'No pending payment for this user.');
    investments.push({
      id: investments.length + 1,
      user_id: uid,
      ...pending.plan,
      status: 'active',
      start_date: new Date(),
      end_date: new Date(Date.now() + pending.plan.duration * 24 * 60 * 60 * 1000)
    });
    users[uid].active_investments += 1;
    users[uid].pending_investment = null;

    if (users[uid].referred_by) {
      const refUser = Object.values(users).find(u => u.referral_code === users[uid].referred_by);
      if (refUser) refUser.referral_earning += 20;
    }

    await sendMessage(uid, `✅ Your investment is approved!\nPlan: ${pending.plan.plan_name}\nAmount: ₹${pending.amount}\nReturn: ₹${pending.plan.return_amount} in ${pending.plan.duration} days.`);
    await sendMessage(chat_id, `Approved investment for user ${uid}.`);
    delete pending_payments[uid];
  }

  else if (text.startsWith('/reject_') && chat_id.toString() === ADMIN_CHAT_ID) {
    const uid = text.split('_')[1];
    if (!pending_payments[uid]) return await sendMessage(chat_id, 'No pending payment for this user.');
    await sendMessage(uid, '❌ Your payment was rejected. Contact @chieffundora for help.');
    delete pending_payments[uid];
    await sendMessage(chat_id, `Rejected payment for user ${uid}.`);
  }

  else if (text.startsWith('/withdraw_approve_') && chat_id.toString() === ADMIN_CHAT_ID) {
    const uid = text.split('_')[2];
    const w = pending_withdrawals[uid];
    if (!w) return await sendMessage(chat_id, 'No pending withdrawal for this user.');
    w.status = 'approved';
    await sendMessage(uid, '✅ Your withdrawal has been approved and processed.');
    await sendMessage(chat_id, `Withdrawal approved for user ${uid}.`);
    delete pending_withdrawals[uid];
  }

  else if (text.startsWith('/withdraw_reject_') && chat_id.toString() === ADMIN_CHAT_ID) {
    const uid = text.split('_')[2];
    const w = pending_withdrawals[uid];
    if (!w) return await sendMessage(chat_id, 'No pending withdrawal for this user.');
    users[uid].wallet_balance += w.amount;
    await sendMessage(uid, '❌ Your withdrawal was rejected. Contact @chieffundora for help.');
    await sendMessage(chat_id, `Withdrawal rejected for user ${uid}.`);
    delete pending_withdrawals[uid];
  }

  else {
    await sendMessage(chat_id, 'Unknown command. Use /invest, /wallet, /withdraw, /refer');
  }
}

// Express server
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
