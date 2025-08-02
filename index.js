const axios = require('axios');
const QRCode = require('qrcode');
const express = require('express');
const bodyParser = require('body-parser');

// --- ⚙️ CONFIGURATION ---
// IMPORTANT: I have put your NEW, SECRET token here. If you didn't create one, the old one will work for now.
const BOT_TOKEN = '8114710727:AAFb76pLg6QhHed3JB0WyHXQcsbpDJXVq4U'; 
// IMPORTANT: Replace this with your NUMERIC ID from @userinfobot. NOT a username.
const ADMIN_CHAT_ID = '7972815378'; 

const UPI_ID = 'fundora@kiwi';
const BOT_USERNAME = 'fundoraxbot';
const SUPPORT_USERNAME = 'fundoraagent';
const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

// --- 💾 IN-MEMORY DATABASE ---
let users = {};
let investments = [];
let withdrawals = [];
let pending_payments = {};
let pending_withdrawals = {};

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

function getUPILink(amount, note = 'Fundora Investment') {
  return `upi://pay?pa=${UPI_ID}&pn=Fundora&am=${amount}&cu=INR&tn=${encodeURIComponent(note)}`;
}

async function sendUPIQR(chat_id, amount) {
    const upiLink = getUPILink(amount);
    const caption = `Tap to copy the UPI ID or use the link to pay ₹${amount}.\n\n*UPI ID:* \`${UPI_ID}\`\n\n[Pay ₹${amount} via UPI](${upiLink})`;
    await sendMessage(chat_id, caption);
}


// ---  MAIN BOT LOGIC ---
async function handleUpdate(body) {
  const message = body.message || (body.callback_query && body.callback_query.message);
  if (!message) {
    console.log("Received a non-message update, skipping.");
    return;
  }

  const chat_id = message.chat.id;
  const user_id = message.chat.id;
  const text = (message.text || '').trim();
  const photo = message.photo;
  
  if (!users[user_id]) {
    users[user_id] = {
      id: user_id, name: message.chat.first_name || 'User', wallet_balance: 0,
      referral_earning: 0, total_withdrawn: 0, active_investments: 0, level: 0,
      referral_code: `FND${user_id}`, referred_by: null, state: null, state_data: {}
    };
  }
  const user = users[user_id];

  if (user.state) {
    switch (user.state) {
      case 'awaiting_utr':
        if (text && text.match(/^\d{10,18}$/)) {
            pending_payments[user_id].utr = text;
            user.state = 'awaiting_screenshot';
            await sendMessage(chat_id, '✅ UTR received.\n\nNow, please upload the payment screenshot.');
        } else {
            await sendMessage(chat_id, '❌ Invalid UTR. Please send a valid UPI Transaction ID (it is usually 12 digits long).');
        }
        return;
      case 'awaiting_screenshot':
        if (photo) {
            const file_id = photo[photo.length - 1].file_id;
            pending_payments[user_id].screenshot_file_id = file_id;
            user.state = null;
            const pending = pending_payments[user_id];
            await sendMessage(chat_id, '🕒 Thank you! Your payment is submitted and is now pending approval.');
            const adminCaption = `🆕 New Payment Pending\n\n*User:* ${user.name} (\`${user_id}\`)\n*Plan:* ${pending.plan.plan_name}\n*Amount:* ₹${pending.amount}\n*UTR:* ${pending.utr}\n\nApprove: /approve_${user_id}\nReject: /reject_${user_id}`;
            await sendPhoto(ADMIN_CHAT_ID, file_id, adminCaption);
        } else {
            await sendMessage(chat_id, '❌ That\'s not a photo. Please upload your payment screenshot.');
        }
        return;
      case 'awaiting_withdrawal_method':
          const choice = text.toLowerCase();
          if(choice === 'upi' || choice === 'bank transfer'){
              user.state_data.method = choice;
              user.state = 'awaiting_withdrawal_details';
              if(choice === 'upi'){
                  await sendMessage(chat_id, "Please provide your UPI details:\n`UPI ID, Registered Name`");
              } else {
                  await sendMessage(chat_id, "Please provide your Bank details:\n`Account Number, IFSC Code, Account Holder Name`");
              }
          } else {
              await sendMessage(chat_id, "Invalid option. Please type `UPI` or `Bank Transfer`.");
          }
        return;
      case 'awaiting_withdrawal_details':
        if (!user.state_data || !user.state_data.method) {
            user.state = null;
            await sendMessage(chat_id, "Something went wrong. Please start again with /withdraw.");
            return;
        }
        const details = text.split(',').map(item => item.trim());
        const method = user.state_data.method;
        let valid = false;
        let detailsText = '';
        if (method === 'upi' && details.length === 2) {
            user.withdrawal_details = { method: 'UPI', upi_id: details[0], name: details[1] };
            detailsText = `*Method:* UPI\n*UPI ID:* \`${details[0]}\`\n*Name:* ${details[1]}`;
            valid = true;
        } else if (method === 'bank transfer' && details.length === 3) {
            user.withdrawal_details = { method: 'Bank', acc_no: details[0], ifsc: details[1], name: details[2] };
            detailsText = `*Method:* Bank\n*Account:* \`${details[0]}\`\n*IFSC:* \`${details[1]}\`\n*Name:* ${details[2]}`;
            valid = true;
        }

        if(valid){
            await sendMessage(chat_id, `✅ Your withdrawal details are saved.\n\n*WARNING:* If the information is wrong, your payment may be lost.`);
            const { withdraw_amount, reinvest_amount, transfer_amount } = user.state_data;
            investments.push({
                id: investments.length + 1, user_id, plan_name: 'Auto Reinvest', amount: reinvest_amount,
                return_amount: reinvest_amount * 1.5, duration: 45, status: 'active',
                start_date: new Date(), end_date: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000)
            });
            user.wallet_balance = 0;
            user.total_withdrawn += transfer_amount;
            user.level += 1;
            pending_withdrawals[user_id] = { user_id, amount: transfer_amount, details: user.withdrawal_details, reinvested_amount };
            await sendMessage(chat_id, `✅ Withdrawal request sent!\n\n*To be paid:* ₹${transfer_amount}\n*Auto-reinvested:* ₹${reinvest_amount}`);
            const adminWithdrawalMsg = `💸 New Withdrawal Request\n\n*User:* ${user.name} (\`${user_id}\`)\n*Amount:* ₹${transfer_amount}\n\n*Details:*\n${detailsText}\n\nApprove: /w_approve_${user_id}\nReject: /w_reject_${user_id}`;
            await sendMessage(ADMIN_CHAT_ID, adminWithdrawalMsg);
            user.state = null;
            user.state_data = {};
        } else {
            await sendMessage(chat_id, `❌ Invalid format. Please provide details exactly as requested.`);
        }
        return;
    }
  }

  const command = text.split(' ')[0];
  switch (command) {
    case '/start':
      const refCode = text.split(' ')[1] || null;
      if (refCode && !user.referred_by && refCode !== user.referral_code) {
        user.referred_by = refCode;
        await sendMessage(chat_id, `You were referred by user ${refCode}.`);
      }
      await sendMessage(chat_id, `👋 Welcome to Fundora, ${user.name}!\n\n/invest - Start an investment\n/wallet - Check your balance\n/withdraw - Withdraw earnings\n/refer - Get your referral link\n/support - Contact support`);
      break;
    case '/invest':
      await sendMessage(chat_id, `Choose a plan by replying with \`invest 1\` or \`invest 2\`:\n\n*1. Fundora Industry*\n> Invest: ₹100, Return: 50% in 45 days\n\n*2. Fundora Space*\n> Invest: ₹200, Return: 100% in 90 days`);
      break;
    case 'invest':
        const planId = text.split(' ')[1];
        if (!['1', '2'].includes(planId)) {
            await sendMessage(chat_id, 'Invalid plan. Use `/invest` then reply `invest 1` or `invest 2`.');
            return;
        }
        const plan = planId === '1'
            ? { plan_name: 'Fundora Industry', amount: 100, return_amount: 150, duration: 45 }
            : { plan_name: 'Fundora Space', amount: 200, return_amount: 400, duration: 90 };
        await sendUPIQR(chat_id, plan.amount);
        pending_payments[user_id] = { amount: plan.amount, plan: plan };
        user.state = 'awaiting_utr';
        await sendMessage(chat_id, 'After paying, please reply with the *UPI Transaction ID (UTR)*.');
        break;
    case '/wallet':
      await sendMessage(chat_id, `*Wallet* 🏦\n\nBalance: ₹${user.wallet_balance.toFixed(2)}\nReferral Earning: ₹${user.referral_earning.toFixed(2)}\nTotal Withdrawn: ₹${user.total_withdrawn.toFixed(2)}`);
      break;
    case '/withdraw':
        if (user.wallet_balance < 50) {
            await sendMessage(chat_id, '❌ Minimum ₹50 required to withdraw.');
            return;
        }
        user.state = 'awaiting_withdrawal_method';
        user.state_data = { 
            withdraw_amount: user.wallet_balance, 
            reinvest_amount: Math.floor(user.wallet_balance * 0.5), 
            transfer_amount: user.wallet_balance - Math.floor(user.wallet_balance * 0.5) 
        };
        await sendMessage(chat_id, `Your balance is ₹${user.state_data.withdraw_amount.toFixed(2)}. 50% will be reinvested.\n\n*Payable:* ₹${user.state_data.transfer_amount.toFixed(2)}\n*Reinvested:* ₹${user.state_data.reinvest_amount.toFixed(2)}\n\nHow do you want payment? Type \`UPI\` or \`Bank Transfer\`.`);
        break;
    case '/refer':
      await sendMessage(chat_id, `Your referral link:\n` +
                                 `https://t.me/${BOT_USERNAME}?start=${user.referral_code}\n\n` +
                                 `*Total Referral Earnings:* ₹${user.referral_earning}`);
      break;
    case '/support':
      await sendMessage(chat_id, `For help, contact support: @${SUPPORT_USERNAME}`);
      break;
    // ... other cases
    default:
        if (chat_id.toString() === ADMIN_CHAT_ID) {
            if (text.startsWith('/approve_')) {
                const id = text.split('_')[1];
                const p = pending_payments[id];
                if (!p) { await sendMessage(ADMIN_CHAT_ID, `No pending payment for ${id}.`); return; }
                investments.push({ id: investments.length + 1, user_id: parseInt(id), status: 'active', ...p.plan, start_date: new Date(), end_date: new Date(Date.now() + p.plan.duration * 24 * 60 * 60 * 1000) });
                const u = users[id]; u.active_investments += 1;
                if (u.referred_by && u.active_investments === 1) {
                    const r = Object.values(users).find(usr => usr.referral_code === u.referred_by);
                    if (r) { r.referral_earning += 20; r.wallet_balance += 20; await sendMessage(r.id, `🎉 You received ₹20 bonus as ${u.name} invested!`); }
                }
                await sendMessage(id, `✅ Your investment is approved!\n*Plan:* ${p.plan.plan_name}\n*Amount:* ₹${p.amount}`);
                await sendMessage(ADMIN_CHAT_ID, `✅ Approved investment for ${id}.`);
                delete pending_payments[id];
            } else if (text.startsWith('/reject_')) {
                const id = text.split('_')[1];
                if (pending_payments[id]) {
                    delete pending_payments[id];
                    await sendMessage(id, '❌ Your payment was rejected. Contact support.');
                    await sendMessage(ADMIN_CHAT_ID, `❌ Rejected payment for ${id}.`);
                }
            } else if (text.startsWith('/w_approve_')) {
                const id = text.split('_')[1];
                const p = pending_withdrawals[id];
                if (p) {
                    await sendMessage(id, `✅ Your withdrawal for ₹${p.amount} is approved.`);
                    await sendMessage(ADMIN_CHAT_ID, `✅ Withdrawal for ${id} approved. *Remember to send ₹${p.amount} manually!*`);
                    delete pending_withdrawals[id];
                }
            } else if (text.startsWith('/w_reject_')) {
                const id = text.split('_')[1];
                const p = pending_withdrawals[id]; const u = users[id];
                if (p && u) {
                    const total = p.amount + p.reinvested_amount;
                    u.wallet_balance += total; u.total_withdrawn -= p.amount; u.level -= 1;
                    const i = investments.findIndex(inv => inv.user_id == id && inv.plan_name === 'Auto Reinvest');
                    if(i > -1) investments.splice(i, 1);
                    await sendMessage(id, `❌ Withdrawal rejected. ₹${total} returned to wallet.`);
                    await sendMessage(ADMIN_CHAT_ID, `❌ Withdrawal for ${id} rejected.`);
                    delete pending_withdrawals[id];
                }
            } else { await sendMessage(chat_id, 'Unknown admin command.'); }
        } else { await sendMessage(chat_id, 'Unknown command.'); }
      break;
  }
}

// --- EXPRESS SERVER FOR WEBHOOK ---
const app = express();
app.use(bodyParser.json());

app.post(`/webhook`, async (req, res) => {
  try { await handleUpdate(req.body); } catch (error) { console.error('FATAL ERROR in handleUpdate:', error); }
  res.status(200).send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Bot server running on port ${PORT}`);
  try {
    // THIS IS THE FIX. It now uses your actual Render URL.
    const webhookUrl = `https://fundorabot.onrender.com/webhook`;
    
    // Check if BOT_TOKEN and ADMIN_CHAT_ID are set correctly
    if (!BOT_TOKEN || BOT_TOKEN === 'PASTE_YOUR_NEW_SECRET_BOT_TOKEN_HERE') {
        console.error("FATAL: BOT_TOKEN is not set. Please add it to the code.");
        return;
    }
    if (!ADMIN_CHAT_ID || ADMIN_CHAT_ID === 'PUT_YOUR_NUMERIC_ADMIN_ID_HERE') {
        console.error("FATAL: ADMIN_CHAT_ID is not set. Please add your numeric ID to the code.");
        return;
    }

    const response = await axios.get(`${API_URL}/setWebhook?url=${webhookUrl}`);
    console.log(`Webhook set successfully to: ${webhookUrl}`);
  } catch (e) {
    console.error('Error setting webhook:', e.response ? e.response.data : e.message);
  }
});
