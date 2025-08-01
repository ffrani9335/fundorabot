const axios = require('axios');
const QRCode = require('qrcode');
const express = require('express');
const bodyParser = require('body-parser');

// --- ⚙️ CONFIGURATION ---
// Replace with your actual bot token
const BOT_TOKEN = 'YOUR_BOT_TOKEN_HERE';
// Replace with your own Telegram user ID (you can get it from @userinfobot)
const ADMIN_CHAT_ID = 'YOUR_ADMIN_CHAT_ID';

const UPI_ID = 'fundora@kiwi';
const BOT_USERNAME = 'fundoraxbot'; // Your bot's username without the '@'
const SUPPORT_USERNAME = 'fundoraagent'; // Support agent's username without the '@'

const API_URL = `https://api.telegram.org/bot${BOT_TOKEN}`;

// --- 💾 IN-MEMORY DATABASE (for simplicity) ---
let users = {};          // { user_id: { data... } }
let investments = [];
let withdrawals = [];
let pending_payments = {}; // { user_id: { amount, plan, utr, screenshot_file_id } }
let pending_withdrawals = {}; // { user_id: { amount, details } }

// --- 🤖 TELEGRAM HELPER FUNCTIONS ---

async function sendMessage(chat_id, text, opts = {}) {
  try {
    await axios.post(`${API_URL}/sendMessage`, { chat_id, text, parse_mode: 'Markdown', ...opts });
  } catch (error) {
    console.error('Error sending message:', error.response ? error.response.data : error.message);
  }
}

async function sendPhoto(chat_id, photo, caption, opts = {}) {
  try {
    await axios.post(`${API_URL}/sendPhoto`, { chat_id, photo, caption, parse_mode: 'Markdown', ...opts });
  } catch (error) {
    console.error('Error sending photo:', error.response ? error.response.data : error.message);
  }
}

// --- 💰 PAYMENT & QR CODE FUNCTIONS ---

function getUPILink(amount, note = 'Fundora Investment') {
  return `upi://pay?pa=${UPI_ID}&pn=Fundora&am=${amount}&cu=INR&tn=${encodeURIComponent(note)}`;
}

async function sendUPIQR(chat_id, amount) {
  const upiLink = getUPILink(amount);
  // qrcode.toDataURL returns a base64 encoded image string, which Telegram API cannot directly use.
  // We need to send it as a buffer. For simplicity with axios, we'll send it as a URL.
  // In a real production app, you might upload this to a temporary host or use a different method.
  // For now, let's stick with sending the UPI link and text details.
  // Sending QR via data URL is not directly supported by Telegram Bot API's `sendPhoto` with a POST request.
  // A common workaround is to save the file and send it, or host it.
  // Let's send a clear message with a link instead, which is more reliable.

  const qrCodeImage = await QRCode.toDataURL(upiLink);
  // The Data URL (base64) needs to be sent as a proper photo.
  // A simple way is to just send the link and text.
  const caption = `Scan the QR Code to pay ₹${amount} or use the details below:\n\n*UPI ID:* \`${UPI_ID}\` (Tap to copy)\n\n[Pay ₹${amount} via UPI](${upiLink})`;
  await sendMessage(chat_id, caption);
}


// ---  મુખ્ય BOT LOGIC ---

async function handleUpdate(body) {
  const message = body.message || body.callback_query.message;
  const data = body.callback_query ? body.callback_query.data : null;
  const chat_id = message.chat.id;
  const user_id = message.chat.id;
  const text = (message.text || '').trim();
  const photo = message.photo;

  // Register user if they don't exist
  if (!users[user_id]) {
    users[user_id] = {
      id: user_id,
      name: message.chat.first_name,
      wallet_balance: 0,
      referral_earning: 0,
      total_withdrawn: 0,
      active_investments: 0,
      level: 0,
      referral_code: `FND${user_id}`, // This will be unique for each user
      referred_by: null,
      state: null, // To track user's current action (e.g., 'awaiting_utr')
      withdrawal_details: {}
    };
  }

  const user = users[user_id];

  // --- State-based Input Handling (for multi-step processes) ---
  if (user.state) {
    switch (user.state) {
      case 'awaiting_utr':
        if (text && text.match(/^\d{10,18}$/)) {
            pending_payments[user_id].utr = text;
            user.state = 'awaiting_screenshot';
            await sendMessage(chat_id, '✅ UTR received.\n\nNow, please upload the payment screenshot.');
        } else {
            await sendMessage(chat_id, '❌ Invalid UTR. Please send a valid UPI Transaction ID (10-18 digits).');
        }
        return;

      case 'awaiting_screenshot':
        if (photo) {
            const file_id = photo[photo.length - 1].file_id;
            pending_payments[user_id].screenshot_file_id = file_id;
            user.state = null; // End the process from user side

            const pending = pending_payments[user_id];
            await sendMessage(chat_id, '🕒 Thank you! Your payment is submitted and is now pending. Fundora will check it and approve it shortly.');

            // Notify Admin
            const adminCaption = `🆕 New Payment Pending Approval\n\n` +
                                 `*User:* ${user.name} (\`${user_id}\`)\n` +
                                 `*Plan:* ${pending.plan.plan_name}\n` +
                                 `*Amount:* ₹${pending.amount}\n` +
                                 `*UTR:* ${pending.utr}\n\n` +
                                 `*Actions:*\n` +
                                 `Approve: /approve_${user_id}\n` +
                                 `Reject: /reject_${user_id}`;
            await sendPhoto(ADMIN_CHAT_ID, file_id, adminCaption);
        } else {
            await sendMessage(chat_id, '❌ That\'s not a photo. Please upload your payment screenshot.');
        }
        return;
      
      case 'awaiting_withdrawal_method':
          if(text.toLowerCase() === 'upi' || text.toLowerCase() === 'bank transfer'){
              user.state_data.method = text.toLowerCase();
              if(user.state_data.method === 'upi'){
                  user.state = 'awaiting_withdrawal_details';
                  await sendMessage(chat_id, "Please provide your UPI details in this format:\n\n`UPI ID, Registered Name`\n\n*Example:*\n`yourname@okhdfc, John Doe`");
              } else { // Bank Transfer
                  user.state = 'awaiting_withdrawal_details';
                  await sendMessage(chat_id, "Please provide your Bank details in this format:\n\n`Account Number, IFSC Code, Account Holder Name`\n\n*Example:*\n`1234567890, SBIN0001234, John Doe`");
              }
          } else {
              await sendMessage(chat_id, "Invalid option. Please type `UPI` or `Bank Transfer`.");
          }
        return;

      case 'awaiting_withdrawal_details':
        const details = text.split(',').map(item => item.trim());
        const method = user.state_data.method;
        let valid = false;
        let detailsText = '';

        if (method === 'upi' && details.length === 2) {
            user.withdrawal_details = { method: 'UPI', upi_id: details[0], name: details[1] };
            detailsText = `*Method:* UPI\n*UPI ID:* ${details[0]}\n*Name:* ${details[1]}`;
            valid = true;
        } else if (method === 'bank' && details.length === 3) {
            user.withdrawal_details = { method: 'Bank', acc_no: details[0], ifsc: details[1], name: details[2] };
            detailsText = `*Method:* Bank\n*Account:* ${details[0]}\n*IFSC:* ${details[1]}\n*Name:* ${details[2]}`;
            valid = true;
        }

        if(valid){
            await sendMessage(chat_id, `✅ Your withdrawal details have been saved.\n\n*WARNING:* If you provided wrong information, your payment may be lost. We are not responsible for that.\n\nProcessing your withdrawal request...`);
            
            // Now process the withdrawal
            const { withdraw_amount, reinvest_amount, transfer_amount } = user.state_data;
            
            // Force reinvest
            investments.push({
                id: investments.length + 1, user_id, plan_name: 'Auto Reinvest',
                amount: reinvest_amount, return_amount: reinvest_amount * 1.5, duration: 45,
                status: 'active', start_date: new Date(), end_date: new Date(Date.now() + 45 * 24 * 60 * 60 * 1000)
            });

            user.wallet_balance = 0;
            user.total_withdrawn += transfer_amount; // This will be confirmed after admin approval
            user.level += 1;

            pending_withdrawals[user_id] = {
                user_id, amount: transfer_amount, details: user.withdrawal_details,
                reinvested_amount, status: 'pending'
            };

            await sendMessage(chat_id, `✅ Withdrawal request submitted!\n\n*To be paid:* ₹${transfer_amount}\n*Auto-reinvested:* ₹${reinvest_amount}\n*Your New Level:* ${user.level}\n\nYour request is sent to the admin for approval.`);

            // Notify Admin
            const adminWithdrawalMsg = `💸 New Withdrawal Request\n\n` +
                                       `*User:* ${user.name} (\`${user_id}\`)\n` +
                                       `*Amount to Send:* ₹${transfer_amount}\n\n` +
                                       `*Payment Details:*\n${detailsText}\n\n` +
                                       `*Actions:*\n` +
                                       `Approve: /w_approve_${user_id}\n` +
                                       `Reject: /w_reject_${user_id}`;
            await sendMessage(ADMIN_CHAT_ID, adminWithdrawalMsg);

            user.state = null; // Reset state
            user.state_data = {};

        } else {
            await sendMessage(chat_id, `❌ Invalid format. Please provide the details exactly as requested.`);
        }
        return;

    }
  }


  // --- Command Handlers ---
  const command = text.split(' ')[0];

  switch (command) {
    case '/start':
      const refCode = text.split(' ')[1] || null;
      if (refCode && !user.referred_by && refCode !== user.referral_code) {
        user.referred_by = refCode;
        // Referral commission will be added upon first successful investment
        await sendMessage(chat_id, `You were referred by user ${refCode}. You will both benefit after your first investment!`);
      }
      await sendMessage(chat_id, `👋 Welcome to Fundora, ${user.name}!\n\nUse the commands to navigate the bot:\n/invest - Start an investment\n/wallet - Check your balance\n/withdraw - Withdraw your earnings\n/refer - Get your referral link\n/support - Contact support`);
      break;

    case '/invest':
      await sendMessage(chat_id, `Please choose an investment plan by replying with \`invest 1\` or \`invest 2\`:\n\n*1. Fundora Industry*\n> Invest: ₹100\n> Return: 50% in 45 days (Total ₹150)\n\n*2. Fundora Space*\n> Invest: ₹200\n> Return: 100% in 90 days (Total ₹400)`);
      break;
    
    case 'invest': // Handles "invest 1" and "invest 2"
        const planId = text.split(' ')[1];
        let plan;
        if (planId === '1') {
            plan = { plan_name: 'Fundora Industry', amount: 100, return_amount: 150, duration: 45 };
        } else if (planId === '2') {
            plan = { plan_name: 'Fundora Space', amount: 200, return_amount: 400, duration: 90 };
        } else {
            await sendMessage(chat_id, 'Invalid plan. Please use `/invest` and reply with `invest 1` or `invest 2`.');
            return;
        }

        await sendUPIQR(chat_id, plan.amount);
        pending_payments[user_id] = { amount: plan.amount, plan: plan };
        user.state = 'awaiting_utr';
        await sendMessage(chat_id, 'After paying, please send the *UPI Transaction ID (UTR)* to proceed.');
        break;

    case '/wallet':
      await sendMessage(chat_id, `*Your Wallet Summary* 🏦\n\n*Wallet Balance:* ₹${user.wallet_balance.toFixed(2)}\n*Referral Earning:* ₹${user.referral_earning.toFixed(2)}\n*Total Withdrawn:* ₹${user.total_withdrawn.toFixed(2)}\n*Active Investments:* ${user.active_investments}`);
      break;

    case '/withdraw':
        if (user.wallet_balance < 50) {
            await sendMessage(chat_id, '❌ Minimum ₹50 required in your wallet to withdraw.');
            return;
        }
        
        const withdraw_amount = user.wallet_balance;
        const reinvest_amount = Math.floor(withdraw_amount * 0.5);
        const transfer_amount = withdraw_amount - reinvest_amount;

        user.state = 'awaiting_withdrawal_method';
        user.state_data = { withdraw_amount, reinvest_amount, transfer_amount }; // Store temp data
        
        await sendMessage(chat_id, `*Withdrawal Process Started*\n\nYour withdrawable balance is ₹${withdraw_amount.toFixed(2)}.\nAs per policy, 50% will be reinvested.\n\n*To be paid to you:* ₹${transfer_amount.toFixed(2)}\n*To be reinvested:* ₹${reinvest_amount.toFixed(2)}\n\nHow would you like to receive your payment? Please type \`UPI\` or \`Bank Transfer\`.`);
        break;

    case '/refer':
      await sendMessage(chat_id, `Your personal referral link:\n` +
                                 `https://t.me/${BOT_USERNAME}?start=${user.referral_code}\n\n` +
                                 `Share this link with your friends. You earn a bonus when they make their first investment!\n\n*Total Referral Earnings:* ₹${user.referral_earning}`);
      break;

    case '/support':
      await sendMessage(chat_id, `For any help or questions, please contact our support team: @${SUPPORT_USERNAME}`);
      break;

    case '/myorders':
      const myInvestments = investments.filter(i => i.user_id === user_id);
      if (!myInvestments.length) {
        await sendMessage(chat_id, 'You have no active investments.');
        return;
      }
      const msg = myInvestments.map(i => `➡️ *${i.plan_name}*: ₹${i.amount} (Ends: ${i.end_date.toDateString()})`).join('\n');
      await sendMessage(chat_id, `*Your Active Investments:*\n\n${msg}`);
      break;

    default:
        // --- Admin Commands ---
        if (chat_id.toString() === ADMIN_CHAT_ID) {
            if (text.startsWith('/approve_')) {
                const approve_user_id = text.split('_')[1];
                const pending = pending_payments[approve_user_id];
                if (!pending) {
                    await sendMessage(ADMIN_CHAT_ID, 'No pending payment found for this user or it was already processed.');
                    return;
                }
                
                investments.push({
                    id: investments.length + 1, user_id: approve_user_id, status: 'active',
                    ...pending.plan, start_date: new Date(),
                    end_date: new Date(Date.now() + pending.plan.duration * 24 * 60 * 60 * 1000)
                });

                users[approve_user_id].active_investments += 1;

                // Credit referral if it's the first investment
                if (users[approve_user_id].referred_by && users[approve_user_id].active_investments === 1) {
                    const referrerCode = users[approve_user_id].referred_by;
                    const referrer = Object.values(users).find(u => u.referral_code === referrerCode);
                    if (referrer) {
                        referrer.referral_earning += 20;
                        referrer.wallet_balance += 20;
                        await sendMessage(referrer.id, `🎉 You received ₹20 referral bonus as ${users[approve_user_id].name} made their first investment!`);
                    }
                }

                await sendMessage(approve_user_id, `✅ Your investment has been approved!\n\n*Plan:* ${pending.plan.plan_name}\n*Amount:* ₹${pending.amount}`);
                await sendMessage(ADMIN_CHAT_ID, `✅ Approved investment for user ${approve_user_id}.`);
                delete pending_payments[approve_user_id]; // Clean up
            } else if (text.startsWith('/reject_')) {
                const reject_user_id = text.split('_')[1];
                if (pending_payments[reject_user_id]) {
                    delete pending_payments[reject_user_id];
                    await sendMessage(reject_user_id, '❌ Your payment was rejected by the admin. Please contact support for details.');
                    await sendMessage(ADMIN_CHAT_ID, `❌ Rejected payment for user ${reject_user_id}.`);
                } else {
                    await sendMessage(ADMIN_CHAT_ID, 'No pending payment found for this user.');
                }
            } else if (text.startsWith('/w_approve_')) {
                const w_approve_user_id = text.split('_')[1];
                const w_pending = pending_withdrawals[w_approve_user_id];
                if (w_pending) {
                    w_pending.status = 'approved';
                    await sendMessage(w_approve_user_id, `✅ Your withdrawal request for ₹${w_pending.amount} has been approved. The payment will be sent shortly.`);
                    await sendMessage(ADMIN_CHAT_ID, `✅ Withdrawal for ${w_approve_user_id} approved. *Remember to send ₹${w_pending.amount} manually!*`);
                    delete pending_withdrawals[w_approve_user_id];
                } else {
                    await sendMessage(ADMIN_CHAT_ID, `No pending withdrawal for user ${w_approve_user_id}.`);
                }
            } else if (text.startsWith('/w_reject_')) {
                const w_reject_user_id = text.split('_')[1];
                const w_pending_reject = pending_withdrawals[w_reject_user_id];
                const userToRefund = users[w_reject_user_id];

                if (w_pending_reject && userToRefund) {
                    // Refund money to user's wallet
                    userToRefund.wallet_balance += (w_pending_reject.amount + w_pending_reject.reinvested_amount);
                    userToRefund.total_withdrawn -= w_pending_reject.amount;
                    userToRefund.level -= 1;
                    
                    // Remove the auto-reinvestment
                    const investmentIndex = investments.findIndex(inv => inv.user_id == w_reject_user_id && inv.plan_name === 'Auto Reinvest');
                    if(investmentIndex > -1) investments.splice(investmentIndex, 1);
                    
                    await sendMessage(w_reject_user_id, `❌ Your withdrawal request was rejected. The full amount of ₹${w_pending_reject.amount + w_pending_reject.reinvested_amount} has been returned to your wallet.`);
                    await sendMessage(ADMIN_CHAT_ID, `❌ Withdrawal for ${w_reject_user_id} rejected. Funds returned to user's wallet.`);
                    delete pending_withdrawals[w_reject_user_id];
                } else {
                     await sendMessage(ADMIN_CHAT_ID, `No pending withdrawal for user ${w_reject_user_id}.`);
                }

            } else {
                await sendMessage(chat_id, 'Unknown command.');
            }
        } else {
            await sendMessage(chat_id, 'Sorry, I don\'t understand that command. Please use one of the available commands.');
        }
      break;
  }
}

// --- EXPRESS SERVER FOR WEBHOOK ---
const app = express();
app.use(bodyParser.json());

app.post(`/webhook/${BOT_TOKEN}`, async (req, res) => {
  try {
    await handleUpdate(req.body);
  } catch (error) {
    console.error('Error in handleUpdate:', error);
  }
  res.send('OK');
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, async () => {
  console.log(`Bot server running on port ${PORT}`);
  // Set the webhook
  try {
    const webhookUrl = `https://your-app-url.com/webhook/${BOT_TOKEN}`; // <--- IMPORTANT: Replace with your actual public URL
    const response = await axios.get(`${API_URL}/setWebhook?url=${webhookUrl}`);
    console.log('Webhook set successfully:', response.data);
  } catch (e) {
    console.error('Error setting webhook:', e.message);
  }
});

