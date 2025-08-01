const axios = require('axios');
const QRCode = require('qrcode');
const express = require('express');
const bodyParser = require('body-parser');

console.log('BOT_TOKEN:', process.env.BOT_TOKEN);
console.log('ADMIN_CHAT_ID:', process.env.ADMIN_CHAT_ID);

const BOT_TOKEN = process.env.BOT_TOKEN || '8114710727:AAFb76pLg6QhHed3JB0WyHXQcsbpDJXVq4U';
const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;
const UPI_ID = 'fundora@kiwi';
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || 'YOUR_ADMIN_CHAT_ID'; // Set your Telegram user ID

let users = {};
let investments = [];
let withdrawals = [];
let referrals = [];
let pending_payments = {}; // user_id: {amount, plan, step, utr, screenshot_file_id}
let pending_withdrawals = {}; // user_id: {method, details, amount, status}

async function sendMessage(chat_id, text, opts = {}) {
  try {
    await axios.post(`${API_URL}/sendMessage`, { chat_id, text, ...opts });
  } catch (err) {
    console.error('sendMessage error:', err.response ? JSON.stringify(err.response.data) : err.message);
  }
}

async function sendPhoto(chat_id, photo, caption) {
  try {
    await axios.post(`${API_URL}/sendPhoto`, { chat_id, photo, caption });
  } catch (err) {
    console.error('sendPhoto error:', err.response ? JSON.stringify(err.response.data) : err.message);
  }
}

function getUPILink(amount, note = 'Fundora Investment') {
  return `upi://pay?pa=${UPI_ID}&pn=Fundora&am=${amount}&cu=INR&tn=${encodeURIComponent(note)}`;
}

async function sendUPIQR(chat_id, amount) {
  try {
    const upiLink = getUPILink(amount);
    const qr = await QRCode.toDataURL(upiLink);
    await sendPhoto(chat_id, qr, `Scan to pay ₹${amount} to Fundora\nUPI ID: ${UPI_ID}\n[Pay Now](${upiLink})`);
  } catch (err) {
    console.error('sendUPIQR error:', err.message);
  }
}

async function handleUpdate(body) {
  if (!body.message) return;

  const chat_id = body.message.chat.id;
  const text = (body.message.text || '').trim();
  const user_id = chat_id.toString();

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
      const photoArray = body.message.photo;
      const file_id = photoArray[photoArray.length - 1].file_id;
      pending.screenshot_file_id = file_id;
      pending.step = 3;

      // Notify admin for approval
      await sendMessage(chat_id, '🕒 Payment details submitted. Waiting for Fundora approval. You will be notified after admin checks your payment.');
      await sendPhoto(
        ADMIN_CHAT_ID,
        file_id,
        `🆕 New Payment Pending Approval\nUser: ${users[user_id].name} (${user_id})\nPlan: ${pending.plan.plan_name}\nAmount: ₹${pending.amount}\nUTR: ${pending.utr}\n\nApprove: /approve_${user_id}`
      );
      return;
    }
  }

  // If user is in withdrawal process (waiting for method/details)
  if (pending_withdrawals[user_id] && pending_withdrawals[user_id].status === 'awaiting_method') {
    if (text.toLowerCase() === 'upi') {
      pending_withdrawals[user_id].method = 'UPI';
      pending_withdrawals[user_id].status = 'awaiting_upi';
      await sendMessage(chat_id, 'Please enter your UPI ID:');
      return;
    } else if (text.toLowerCase() === 'bank') {
      pending_withdrawals[user_id].method = 'BANK';
      pending_withdrawals[user_id].status = 'awaiting_bank_acc';
      await sendMessage(chat_id, 'Please enter your Bank Account Number:');
      return;
    } else {
      await sendMessage(chat_id, 'Please reply with "UPI" or "BANK" only.');
      return;
    }
  }
  if (pending_withdrawals[user_id] && pending_withdrawals[user_id].status === 'awaiting_upi') {
    pending_withdrawals[user_id].details = { upi_id: text };
    pending_withdrawals[user_id].status = 'awaiting_upi_name';
    await sendMessage(chat_id, 'Please enter your UPI Registered Name:');
    return;
  }
  if (pending_withdrawals[user_id] && pending_withdrawals[user_id].status === 'awaiting_upi_name') {
    pending_withdrawals[user_id].details.upi_name = text;
    pending_withdrawals[user_id].status = 'pending';
    await sendMessage(chat_id, '⚠️ Warning: If you provide wrong UPI details, your payment may be lost.\n\nYour withdrawal request is pending. Fundora admin will review and approve/reject soon.');
    // Notify admin
    await sendMessage(
      ADMIN_CHAT_ID,
      `🆕 New Withdrawal Pending Approval\nUser: ${users[user_id].name} (${user_id})\nMethod: UPI\nUPI ID: ${pending_withdrawals[user_id].details.upi_id}\nName: ${pending_withdrawals[user_id].details.upi_name}\nAmount: ₹${pending_withdrawals[user_id].amount}\n\nApprove: /approve_withdraw_${user_id}\nReject: /reject_withdraw_${user_id}`
    );
    return;
  }
  if (pending_withdrawals[user_id] && pending_withdrawals[user_id].status === 'awaiting_bank_acc') {
    pending_withdrawals[user_id].details = { acc_no: text };
    pending_withdrawals[user_id].status = 'awaiting_bank_ifsc';
    await sendMessage(chat_id, 'Please enter your Bank IFSC Code:');
    return;
  }
  if (pending_withdrawals[user_id] && pending_withdrawals[user_id].status === 'awaiting_bank_ifsc') {
    pending_withdrawals[user_id].details.ifsc = text;
    pending_withdrawals[user_id].status = 'awaiting_bank_name';
    await sendMessage(chat_id, 'Please enter your Account Holder Name:');
    return;
  }
  if (pending_withdrawals[user_id] && pending_withdrawals[user_id].status === 'awaiting_bank_name') {
    pending_withdrawals[user_id].details.acc_name = text;
    pending_withdrawals[user_id].status = 'pending';
    await sendMessage(chat_id, '⚠️ Warning: If you provide wrong bank details, your payment may be lost.\n\nYour withdrawal request is pending. Fundora admin will review and approve/reject soon.');
    // Notify admin
    await sendMessage(
      ADMIN_CHAT_ID,
      `🆕 New Withdrawal Pending Approval\nUser: ${users[user_id].name} (${user_id})\nMethod: BANK\nAccount No: ${pending_withdrawals[user_id].details.acc_no}\nIFSC: ${pending_withdrawals[user_id].details.ifsc}\nName: ${pending_withdrawals[user_id].details.acc_name}\nAmount: ₹${pending_withdrawals[user_id].amount}\n\nApprove: /approve_withdraw_${user_id}\nReject: /reject_withdraw_${user_id}`
    );
    return;
  }

  // Command Handlers
  if (text.startsWith('/start')) {
    let ref = text.split(' ')[1] || null;
    if (ref && !users[user_id].referred_by && ref !== users[user_id].referral_code) {
      users[user_id].referred_by = ref;
      referrals.push({ from_user: ref, to_user: user_id, commission: 20, created_at: new Date() });
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

  else if (text.toLowerCase() === 'invest 1' || text === 'invest 2') {
    let plan = text.split(' ')[1];
    let planObj = plan === '1'
      ? { plan_name: 'Fundora Industry', amount: 100, return_amount: 150, duration: 45 }
      : { plan_name: 'Fundora Space', amount: 200, return_amount: 400, duration: 90 };
    await sendUPIQR(chat_id, planObj.amount);
    await sendMessage(chat_id, `After payment, reply: paid ${planObj.amount}\n\nEnter your UPI Transaction ID (UTR) and upload screenshot after payment. Your payment will be checked and approved by Fundora admin.`);
    users[user_id].pending_investment = planObj;
  }

  else if (text.startsWith('paid')) {
    let amt = parseInt(text.split(' ')[1]);
    let planObj = users[user_id].pending_investment;
    if (!planObj || planObj.amount !== amt) {
      await sendMessage(chat_id, 'No matching pending investment. Use /invest to start.');
      return;
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
    let myInv = investments.filter(i => i.user_id === user_id);
    if (!myInv.length) return await sendMessage(chat_id, 'No active investments.');
    let msg = myInv.map(i => `${i.plan_name}: ₹${i.amount}, Ends: ${i.end_date.toDateString()}`).join('\n');
    await sendMessage(chat_id, msg);
  }

  else if (text === '/withdraw') {
    let u = users[user_id];
    if (u.wallet_balance < 50) return await sendMessage(chat_id, 'Minimum ₹50 required to withdraw.');
    await sendMessage(chat_id, 'How do you want to withdraw? Reply with "UPI" or "BANK".');
    pending_withdrawals[user_id] = {
      amount: u.wallet_balance,
      status: 'awaiting_method'
    };
    u.wallet_balance = 0;
  }

  else if (text === '/refer') {
    await sendMessage(chat_id, `Invite link: https://t.me/fundoraxbot?start=${users[user_id].referral_code}\nEarnings: ₹${users[user_id].referral_earning}`);
  }

  else if (text === '/support') {
    await sendMessage(chat_id, 'Contact agent: @fundoraagent');
  }

  // Admin approval command for investment
  else if (text.startsWith('/approve_') && chat_id.toString() === ADMIN_CHAT_ID) {
    let approve_user_id = text.split('_')[1];
    let pending = pending_payments[approve_user_id];
    if (!pending) {
      await sendMessage(chat_id, 'No pending payment for this user.');
      return;
    }
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
    if (users[approve_user_id].referred_by) {
      let refUser = Object.values(users).find(u => u.referral_code === users[approve_user_id].referred_by);
      if (refUser) refUser.referral_earning += 20;
    }
    await sendMessage(approve_user_id, `✅ Your investment is approved!\nPlan: ${pending.plan.plan_name}\nAmount: ₹${pending.amount}\nReturn: ₹${pending.plan.return_amount} in ${pending.plan.duration} days.`);
    await sendMessage(chat_id, `Approved investment for user ${approve_user_id}.`);
    delete pending_payments[approve_user_id];
  }

  // Admin approval/reject command for withdrawal
  else if (text.startsWith('/approve_withdraw_') && chat_id.toString() === ADMIN_CHAT_ID) {
    let approve_user_id = text.split('_')[2];
    let pending = pending_withdrawals[approve_user_id];
    if (!pending || pending.status !== 'pending') {
      await sendMessage(chat_id, 'No pending withdrawal for this user.');
      return;
    }
    await sendMessage(approve_user_id, `✅ Your withdrawal of ₹${pending.amount} has been approved and will be processed soon.`);
    await sendMessage(chat_id, `Approved withdrawal for user ${approve_user_id}.`);
    delete pending_withdrawals[approve_user_id];
  }
  else if (text.startsWith('/reject_withdraw_') && chat_id.toString() === ADMIN_CHAT_ID) {
    let reject_user_id = text.split('_')[2];
    let pending = pending_withdrawals[reject_user_id];
    if (!pending || pending.status !== 'pending') {
      await sendMessage(chat_id, 'No pending withdrawal for this user.');
      return;
    }
    users[reject_user_id].wallet_balance += pending.amount;
    await sendMessage(reject_user_id, `❌ Your withdrawal of ₹${pending.amount} has been rejected. Amount refunded to your wallet.`);
    await sendMessage(chat_id, `Rejected withdrawal for user ${reject_user_id}.`);
    delete pending_withdrawals[reject_user_id];
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
