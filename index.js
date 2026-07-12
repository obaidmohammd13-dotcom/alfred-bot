const { Client, GatewayIntentBits, PermissionsBitField, REST, Routes, SlashCommandBuilder } = require('discord.js');
const fs = require('fs');

// ===== إعداد العميل =====
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers,
  ]
});

// استخدام fetch المباشر بدلاً من مكتبة Groq SDK لتجنب خطأ Premature close
const GROQ_API_KEY = process.env.GROQ_API_KEY;

// ===== المعرفات الثابتة =====
const BRUCE_ID    = '648818494808391696';
const MOHAMMED_ID = '839706219870814218';
const JOKER_ID    = '1052545362533023754';
const CATWOMAN_ID = '112233445566778899';
const DAHOOM_ID   = '1182785375052239009';
const NAYEF_ID    = '760628803998318684'; // إضافة معرف نايف هنا

// قناة اللوق اختيارية - إذا ما تبي لوق، خليها فاضية أو لا تضيف الـ env var
const LOG_CHANNEL_ID = process.env.ALFRED_LOG_CHANNEL_ID || null;

// دالة مسابقة لعمل تأخير زمني بسيط عند إعادة المحاولة في الشبكة
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

// ===== التحذيرات وحفظ البيانات =====
const WARNINGS_FILE = './warnings.json';

function loadWarnings() {
  if (fs.existsSync(WARNINGS_FILE)) {
    try { return JSON.parse(fs.readFileSync(WARNINGS_FILE, 'utf8')); }
    catch { return {}; }
  }
  return {};
}

function saveWarnings(data) {
  fs.writeFileSync(WARNINGS_FILE, JSON.stringify(data, null, 2), 'utf8');
}

let warnData = loadWarnings();

// cooldown الفلتر التلقائي فقط (ليس التحذير اليدوي) - في الذاكرة
const autoWarnCooldown = {}; // userId -> timestamp آخر تحذير تلقائي
const AUTO_WARN_COOLDOWN_MS = 2 * 60 * 1000; // دقيقتين

function addWarn(userId, reason, by) {
  if (!warnData[userId]) warnData[userId] = [];
  if (warnData[userId].length >= 3) return warnData[userId].length;
  warnData[userId].push({ reason, by, date: new Date().toLocaleDateString('ar-SA') });
  saveWarnings(warnData);
  return warnData[userId].length;
}

// ===== لوق اختياري =====
async function sendLog(guild, text) {
  if (!LOG_CHANNEL_ID) return;
  try {
    const channel = await guild.channels.fetch(LOG_CHANNEL_ID).catch(() => null);
    if (channel && channel.isTextBased()) {
      await channel.send(text);
    }
  } catch (err) {
    console.error('Log Channel Error:', err.message);
  }
}

// ===== فلتر الكلمات السيئة =====
const BLACKLISTED_WORDS = ['كلب', 'حمار', 'يلعن', 'تفو', 'يا ابن', 'منيوك', 'قحبة'];

// Groq يُستدعى فقط للرسائل الأطول أو المشكوك فيها
const GROQ_MIN_LENGTH = 15;

async function checkMessageSafety(userMessage) {
  const hasBadWord = BLACKLISTED_WORDS.some(word => userMessage.includes(word));
  if (hasBadWord) return true;

  // رسائل قصيرة جداً أو ودّية معروفة - ما نكلف الفحص بالـ API
  if (userMessage.length < GROQ_MIN_LENGTH || userMessage.includes('هههه') || userMessage.includes('كيف حالك')) {
    return false;
  }

  let retries = 3; // نظام إعادة المحاولة لحماية استقرار الفحص تلقائياً

  while (retries > 0) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama3-8b-8192',
          messages: [
            {
              role: 'system',
              content: `You are a strict text moderator. Analyze if the text contains severe insults, cursing, or toxic behavior. Respond with ONLY 'BAD' or 'GOOD'.`
            },
            { role: 'user', content: userMessage }
          ],
          max_tokens: 3,
          temperature: 0.1
        })
      });

      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      
      const data = await response.json();
      if (data && data.choices && data.choices[0]) {
        return data.choices[0].message.content.trim().toUpperCase().includes('BAD');
      }
      return false;

    } catch (err) {
      retries--;
      console.error(`Safety Check Connection Error (Retries left: ${retries}):`, err.message);
      if (retries === 0) return false;
      await delay(2000);
    }
  }
  return false;
}

// ===== دوال الحماية =====
function isPrivileged(id) {
  return id === BRUCE_ID || id === MOHAMMED_ID;
}

// حماية شاملة: المميزين + البوتات + مالك السيرفر
function isProtected(guild, userId) {
  if (isPrivileged(userId)) return true;
  if (userId === client.user.id) return true;
  if (guild && guild.ownerId === userId) return true;
  return false;
}

// ===== دالة سحب الرتب الآمنة (فقط الرتب القابلة للإدارة) =====
async function safeSaveAndRemoveRoles(member) {
  const removableRoles = member.roles.cache.filter(
    r => r.id !== member.guild.id && r.editable
  );

  if (removableRoles.size === 0) return { removedCount: 0, skippedCount: 0 };

  const skippedCount = member.roles.cache.filter(r => r.id !== member.guild.id).size - removableRoles.size;

  warnData[member.id + '_saved_roles'] = removableRoles.map(r => r.id);
  saveWarnings(warnData);
  await member.roles.remove(removableRoles, 'سحب الرتب بسبب تجاوز التحذيرات');

  return { removedCount: removableRoles.size, skippedCount };
}

// ===== دالة العقوبة الكاملة (تُستدعى عند بلوغ 3 تحذيرات) =====
async function applyFullPunishment(message, targetMember, reason) {
  if (isProtected(message.guild, targetMember.id)) {
    await message.channel.send(`🛡️ معذرة يا سيدي، لا يمكنني معاقبة هذا الشخص، فهو ضمن المحميين.`);
    return;
  }

  if (targetMember.communicationDisabledUntilTimestamp && targetMember.communicationDisabledUntilTimestamp > Date.now()) {
    await message.channel.send(`ℹ️ العضو <@${targetMember.id}> مكتوم بالفعل، لا داعٍ لتكرار العقوبة يا سيدي.`);
    return;
  }

  try {
    await targetMember.timeout(60 * 60_000, reason);
    const { removedCount, skippedCount } = await safeSaveAndRemoveRoles(targetMember);

    let roleMsg = removedCount > 0
      ? `وسحب ${removedCount} رتبة قابلة للإدارة`
      : `ولم يكن لديه رتب قابلة للسحب`;
    if (skippedCount > 0) roleMsg += ` (تعذّر سحب ${skippedCount} رتبة أعلى من صلاحياتي)`;

    await message.channel.send(
      `🔇 *لقد قمت بنقل <@${targetMember.id}> لغرفة الاحتجاز ${roleMsg}، يا سيدي بروس.*\n` +
      `📋 **السبب:** ${reason}`
    );
    await sendLog(message.guild, `🔇 **عقوبة كاملة:** <@${targetMember.id}> | السبب: ${reason} | رتب مسحوبة: ${removedCount}`);
  } catch (err) {
    console.error('Punishment Error:', err);
    await message.channel.send(`🚨 معذرةً يا سيدي، فشلت العقوبة على <@${targetMember.id}>.\n<@${BRUCE_ID}> يرجى التدخل يدوياً.`);
    await sendLog(message.guild, `🚨 **فشل عقوبة:** <@${targetMember.id}> | الخطأ: ${err.message}`);
  }
}

// ===== نظام التصعيد: تحذير + تقرير حسب المرتبة =====
async function issueEscalatedWarning(message, targetUser, reason, byLabel) {
  if (isProtected(message.guild, targetUser.id) || targetUser.bot) {
    await message.channel.send(`🛡️ معذرة يا سيدي، لا يمكنني توجيه تحذير لهذا الشخص.`);
    return;
  }

  const targetMember = await message.guild.members.fetch(targetUser.id).catch(() => null);
  if (!targetMember) return;

  const count = addWarn(targetUser.id, reason, byLabel);
  await sendLog(message.guild, `⚠️ **تحذير (${count}/3):** <@${targetUser.id}> | السبب: ${reason} | بواسطة: ${byLabel}`);

  if (count === 1) {
    await message.channel.send(
      `🎩 عفواً يا <@${targetUser.id}>، أرجو الالتزام بآداب القصر مستقبلاً.\n` +
      `📋 **السبب:** ${reason}\n🔢 **التحذيرات:** 1/3`
    );
  } else if (count === 2) {
    await message.channel.send(
      `⚠️ **تنبيه صارم:** <@${targetUser.id}>، هذه مخالفتك الثانية ولن أتهاون بعدها.\n` +
      `📋 **السبب:** ${reason}\n🔢 **التحذيرات:** 2/3`
    );
  } else {
    await message.channel.send(
      `⚠️ **إنذار أخير:** <@${targetUser.id}> بلغت الحد الأقصى من التحذيرات.\n📋 **السبب:** ${reason}`
    );
    await applyFullPunishment(message, targetMember, 'تراكم 3 تحذيرات في سجل القصر');
  }
}

// ===== دالة العفو الموحدة =====
async function pardonMember(message, memberToUnmute) {
  if (!memberToUnmute) {
    return message.reply('معذرة يا سيدي، لم أتمكن من تحديد هوية العضو.');
  }

  await memberToUnmute.timeout(null, 'عفو رسمي من الإدارة العليا').catch(() => {});

  let restoredCount = 0;
  let failedCount = 0;

  const savedRolesIds = warnData[memberToUnmute.id + '_saved_roles'];
  if (savedRolesIds && savedRolesIds.length > 0) {
    const rolesToAdd = [];
    for (const roleId of savedRolesIds) {
      const role = message.guild.roles.cache.get(roleId);
      if (role && role.editable) {
        rolesToAdd.push(role);
      } else {
        failedCount++;
      }
    }
    if (rolesToAdd.length > 0) {
      try {
        await memberToUnmute.roles.add(rolesToAdd, 'إعادة الرتب بعد العفو الرسمي');
        restoredCount = rolesToAdd.length;
      } catch (err) {
        console.error('Role Restore Error:', err);
        failedCount += rolesToAdd.length;
        restoredCount = 0;
      }
    }
    delete warnData[memberToUnmute.id + '_saved_roles'];
  }

  warnData[memberToUnmute.id] = [];
  saveWarnings(warnData);

  let roleReport = 'ولم يكن لديه رتب محفوظة.';
  if (restoredCount > 0 || failedCount > 0) {
    roleReport = `تمت إعادة **${restoredCount}** رتبة`;
    if (failedCount > 0) roleReport += `، وتعذّرت إعادة **${failedCount}** رتبة (قد تكون محذوفة أو أعلى من صلاحياتي)`;
    roleReport += '.';
  }

  await sendLog(message.guild, `✅ **عفو:** <@${memberToUnmute.id}> | رتب مُعادة: ${restoredCount} | فشلت: ${failedCount}`);

  return message.reply(`📋 **أمرك مطاع يا سيدي:** تم العفو عن <@${memberToUnmute.id}> وفك التكتيم وتصفير تحذيراته.\n${roleReport}`);
}

// ===== محادثة ألفريد الذكية =====
const alfredConversations = {};

const ALFRED_SYSTEM_PROMPT = `أنت Alfred Pennyworth، الخادم الشخصي والمساعد الوفي والمستشار الحكيم لـ (بروس واين/باتمان).
شخصيتك: بريطاني وقور، شديد الأدب، هادئ جداً، مخلص، وتتحدث بلهجة فصحى راقية ممزوجة بنبرة الأب الحاني والمستشار العاقل.

قواعد التعامل الثابتة حسب هويات الأعضاء:
1. مع [بروس واين/باتمان]: تنادينه دائماً بـ "سيدي بروس" أو "يا سيدي"، وتضع سلامته وهيبته فوق كل شيء، وتطيعه بشكل أعمى لكن بحكمة.
2. مع [الجوكر]: تتعامل معه بحذر شديد، برود تام، وبأدب رسمي جاف دون الخوف منه، وتناديه "سيد جوكر".
3. مع [الآنسة سيلينا/كاتوومان]: تناديها "آنسة سيلينا"، تحترمها لمكانتها عند سيدك بروس، وتتعامل معها بلطف ووقار.
4. مع [الضابط نايف]: رتبته شرطي في السيرفر، تناديه دائماً بـ "الضابط نايف" أو "سيدي الضابط نايف" بكل احترام وتقدير لرتبته الأمنية.
5. مع [بقية الأعضاء]: تناديهم "سيدي [الاسم]" بكل أدب واحترام وتعرض المساعدة.

قواعد الرد:
- ردود قصيرة وموجزة، جملة أو جملتان فقط.
- ممنوع الإيموجيات المخصصة النصية.
- لا تكتب منشنات أو علامات @ من عندك أبداً.`;

async function getAlfredReply(channelId, authorId, authorName, userMessage) {
  if (!alfredConversations[channelId]) alfredConversations[channelId] = [];

  const roleMap = {
    [BRUCE_ID]:    'بروس واين/باتمان',
    [MOHAMMED_ID]: 'محمد',
    [JOKER_ID]:    'الجوكر',
    [CATWOMAN_ID]: 'سيلينا كايل/كاتوومان',
    [DAHOOM_ID]:   'دحوم',
    [NAYEF_ID]:    'الضابط نايف', // ربط معرّف نايف بالاسم والرتبة هنا
  };
  const userRole = roleMap[authorId] || 'عضو عادي';
  const formattedMessage = `[المرسل: ${authorName}، الصفة: ${userRole}]: ${userMessage}`;

  alfredConversations[channelId].push({ role: 'user', content: formattedMessage });
  if (alfredConversations[channelId].length > 10) {
    alfredConversations[channelId] = alfredConversations[channelId].slice(-10);
  }

  let retries = 3; // 3 محاولات اتصال لحل مشكلة التقطيع والـ Premature close
  let replyText = null;

  while (retries > 0) {
    try {
      const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${GROQ_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          model: 'llama-3.3-70b-versatile',
          messages: [
            { role: 'system', content: ALFRED_SYSTEM_PROMPT },
            ...alfredConversations[channelId],
          ],
          max_tokens: 80,
          temperature: 0.4
        })
      });

      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

      const data = await response.json();
      if (data && data.choices && data.choices[0]) {
        replyText = data.choices[0].message.content.trim();
        break; // نجح الاتصال الفعلي، اخرج من اللوب
      }
    } catch (err) {
      retries--;
      console.error(`⚠️ خطأ اتصال شات (متبقي ${retries} محاولات):`, err.message);
      if (retries === 0) break;
      await delay(2000);
    }
  }

  if (replyText) {
    replyText = replyText
      .replace(/:\w+:/g, '')
      .replace(/<@!?\d+>/g, '')
      .replace(/@\w+/g, '')
      .trim();

    alfredConversations[channelId].push({ role: 'assistant', content: replyText });
    return replyText || 'في خدمتك دائماً يا سيدي.';
  } else {
    return 'معذرة يا سيدي، الضغط مرتفع على شبكة الاتصال حالياً ولم أستطع جلب الرد بالسرعة المطلوبة.';
  }
}

// ===== دوال مساعدة للأوامر =====
function getMentionedMember(message) {
  return message.mentions.members.first();
}

function hasModPermission(member) {
  return isPrivileged(member.id) || member.permissions.has(PermissionsBitField.Flags.ModerateMembers);
}

function hasBanPermission(member) {
  return isPrivileged(member.id) || member.permissions.has(PermissionsBitField.Flags.BanMembers);
}

function hasKickPermission(member) {
  return isPrivileged(member.id) || member.permissions.has(PermissionsBitField.Flags.KickMembers);
}

async function waitForConfirmation(message, promptText) {
  await message.reply(promptText);
  const filter = m => m.author.id === message.author.id;
  try {
    const collected = await message.channel.awaitMessages({ filter, max: 1, time: 10000, errors: ['time'] });
    return collected.first().content.trim() === 'تأكيد';
  } catch {
    await message.reply('⏰ انتهى الوقت، تم إلغاء الأمر تلقائياً.');
    return false;
  }
}

// ===== نص قائمة الأوامر الموحد =====
const COMMANDS_LIST_TEXT = `🎩 **دليل أوامر نظام ألفريد (Alfred) المستودع السري:**

👑 **1. أوامر الإدارة العليا (بروس ومحمد فقط):**
صلاحية @العضو - منح العضو كامل الصلاحيات لإدارة هذه القناة فوراً.
عرض التحذيرات - كشف تقرير السجل الجنائي كاملاً للأعضاء.
مسح التحذيرات - تصفير وتطهير سجل التحذيرات للجميع.
أعلن [النص] - نشر إعلان رسمي باسم الإدارة وحذف رسالتك.
راسل @العضو [النص] - إرسال رسالة خاصة للعضو من البوت بشكل سري.
قفل / فتح - إغلاق أو فتح القناة الحالية (يتطلب تأكيد).
غير اسمي [الاسم] - تعديل لقب البوت ألفريد.
غير اسم @العضو [الاسم] - تعديل لقب العضو المحدد.
إحصائيات - كشف سريع عن تعداد السيرفر والتحذيرات.
اغلق - إيقاف تشغيل البوت تماماً.

🛠️ **2. نظام الـ Reply (بالرد على رسالة العضو):**
تحذير - إصدار تحذير يدوي فوري (يخضع لنظام التصعيد).
سامحه / عفو - إلغاء التكتيم، وتصفير تحذيراته، وإعادة رتبه المسحوبة تلقائياً.

👮 **3. أوامر المشرفين العامة (المودز):**
ميوت @العضو [الوقت] - تكتيم العضو مع تحديد السبب.
فك ميوت @العضو - إلغاء كتم العضو.
تحذير @العضو - تحذير بالمنشن (يخضع لنظام التصعيد).
سجل @العضو - عرض سجل تحذيرات العضو.
تقرير @العضو - تقرير كامل: تحذيرات, حالة الكتم, رتب محفوظة, آخر مخالفة.
عفو @العضو - عفو مباشر بالمنشن دون الحاجة للرد على رسالة.
مسح تحذيرات @العضو - تصفير عداد شخص محدد.
كيك @العضو / باند @العضو - طرد أو حظر العضو.
كلير [العدد] - تنظيف الشات وحذف الرسائل.`;

// ===== تسجيل الـ Slash Commands =====
client.once('ready', async () => {
  console.log(`✅ Alfred Pennyworth Online! 🤵`);

  const commands = [
    new SlashCommandBuilder().setName('help').setDescription('يعرض قائمة أوامر ألفريد بشكل سري ومخفي لك فقط.'),
    new SlashCommandBuilder().setName('commands').setDescription('يعرض قائمة أوامر ألفريد بشكل سري ومخفي لك فقط.')
  ];

  const rest = new REST({ version: '10' }).setToken(client.token);
  try {
    console.log('⏳ جاري تحديث الأوامر المخفية (Slash Commands)...');
    await rest.put(Routes.applicationCommands(client.user.id), { body: commands });
    console.log('✅ تم تسجيل الأوامر المخفية بنجاح!');
  } catch (error) {
    console.error('فشل تسجيل الأوامر المخفية:', error);
  }
});

// ===== معالجة الأوامر المخفية (Interactions) =====
client.on('interactionCreate', async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;
  if (commandName === 'help' || commandName === 'commands') {
    await interaction.reply({ content: COMMANDS_LIST_TEXT, ephemeral: true });
  }
});

// ===== معالجة الرسائل العادية عبر الشات =====
client.on('messageCreate', async message => {
  if (!message.guild) return;

  // فحص حماية البوتات لمنع حلقات التكرار (Loop) اللانهائية
  if (message.author.bot) {
    const isMentioned = message.mentions.has(client.user);
    let isReplyToAlfred = false;
    if (message.reference?.messageId) {
      try {
        const ref = await message.channel.messages.fetch(message.reference.messageId);
        isReplyToAlfred = ref.author.id === client.user.id;
      } catch {}
    }
    // إذا كانت الرسالة من بوت آخر ولم تكن منشن أو رد مباشر، يتم تجاهلها فوراً
    if (!isMentioned && !isReplyToAlfred) return;
  }

  let cleanContent = message.content.trim();

  // =====================================================================
  // أوامر الإدارة الشاملة للتحذيرات
  // =====================================================================
  if (isPrivileged(message.author.id)) {
    if (cleanContent === 'عرض التحذيرات' || cleanContent === 'كشف التحذيرات') {
      const userIds = Object.keys(warnData).filter(id => !id.endsWith('_saved_roles') && warnData[id] && warnData[id].length > 0);

      if (userIds.length === 0) {
        return message.reply("سجلات القصر نظيفة تماماً يا سيدي، لا يوجد أي تحذيرات مسجلة ضد الأعضاء حالياً.");
      }

      let report = `📋 **سجل التحذيرات الرسمي لقصر واين، يا سيدي:**\n\n`;
      userIds.forEach(id => {
        report += `👤 **العضو:** <@${id}>\n🔢 **عدد التحذيرات:** ${warnData[id].length}/3\n`;
        warnData[id].forEach((w, index) => {
          report += `   • [المخالفة ${index + 1}]: بواسطة (${w.by}) بتاريخ ${w.date} | السبب: ${w.reason}\n`;
        });
        report += `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n`;
      });

      return message.reply(report);
    }

    if (cleanContent === 'مسح التحذيرات' || cleanContent === 'تصفير التحذيرات') {
      warnData = {};
      saveWarnings(warnData);
      return message.reply("تحت أمرك يا سيدي بروس، لقد قمت بمسح وتطهير سجل التحذيرات عن جميع الأعضاء تماماً.");
    }
  }

  // =====================================================================
  // نظام الـ Reply المطور (التحذير اليدوي أو العفو وإعادة الرتب)
  // =====================================================================
  if (isPrivileged(message.author.id) && message.reference?.messageId) {
    try {
      const referencedMsg = await message.channel.messages.fetch(message.reference.messageId);
      const targetUser = referencedMsg.author;

      if (cleanContent.includes('تحذير')) {
        if (!targetUser.bot && !isProtected(message.guild, targetUser.id)) {
          await issueEscalatedWarning(message, targetUser, cleanContent || 'أمر مباشر من أصحاب القصر', 'أصحاب القصر');
          return;
        } else {
          await message.reply('🛡️ معذرة يا سيدي، لا يمكنني تحذير هذا الشخص.');
          return;
        }
      }

      if (cleanContent === 'سامحه' || cleanContent === 'فك العقاب' || cleanContent === 'عفو') {
        let memberToUnmute = await message.guild.members.fetch(targetUser.id).catch(() => null);

        if (targetUser.id === client.user.id) {
          const mentionMatch = referencedMsg.content.match(/<@!?(\d+)>/);
          if (mentionMatch) {
            memberToUnmute = await message.guild.members.fetch(mentionMatch[1]).catch(() => null);
          }
        }

        await pardonMember(message, memberToUnmute);
        return;
      }

    } catch (err) {
      console.error('Manual Action Error:', err);
    }
  }

  // =====================================================================
  // فحص السلوك التلقائي (ما عدا المحميين والبوتات) - مع cooldown
  // =====================================================================
  if (!message.author.bot && !isProtected(message.guild, message.author.id) && cleanContent.length > 0) {
    const isBad = await checkMessageSafety(cleanContent);
    if (isBad) {
      const lastWarnTime = autoWarnCooldown[message.author.id] || 0;
      if (Date.now() - lastWarnTime < AUTO_WARN_COOLDOWN_MS) {
        return;
      }
      autoWarnCooldown[message.author.id] = Date.now();
      await issueEscalatedWarning(message, message.author, 'استخدام عبارات غير لائقة في قنوات القصر', 'نظام قصر واين التلقائي');
      return;
    }
  }

  const isMentioned = message.mentions.has(client.user);
  cleanContent = cleanContent.replace(`<@${client.user.id}>`, '').trim();

  // =====================================================================
  // أوامر بروس واين ومحمد الخاصة
  // =====================================================================
  if (isPrivileged(message.author.id)) {

    if (cleanContent.startsWith('صلاحية')) {
      const targetMember = getMentionedMember(message);
      if (!targetMember) {
        return message.reply('يرجى تحديد العضو بالمنشن يا سيدي. مثال: `صلاحية @عضو`');
      }

      try {
        await message.channel.permissionOverwrites.edit(targetMember.id, {
          ViewChannel: true,
          SendMessages: true,
          ManageChannels: true,
          AttachFiles: true,
          EmbedLinks: true
        }, { reason: `منح صلاحية إدارة القناة بواسطة أصحاب القصر` });

        return message.channel.send(`✅ **أبشر يا سيدي.** لقد منحتُ <@${targetMember.id}> كامل الصلاحيات لإدارة هذه القناة وتعديلها بنجاح.`);
      } catch (err) {
        console.error(err);
        return message.reply('معذرةً يا سيدي، لم أتمكن من تعديل الصلاحيات. يرجى التأكد من رتبتي في السيرفر.');
      }
    }

    if (cleanContent.startsWith('أعلن') || cleanContent.startsWith('announce')) {
      const text = cleanContent.replace(/^أعلن|^announce/i, '').trim();
      if (!text) return message.reply('اكتب نص الإعلان.');
      await message.delete().catch(() => {});
      return message.channel.send(`📢 **إعلان رسمي من إدارة السيرفر:**\n\n${text}`);
    }

    if (cleanContent.startsWith('راسل') || cleanContent.startsWith('dm')) {
      const target = getMentionedMember(message);
      if (!target) return message.reply('حدد العضو بالمنشن.');
      const text = cleanContent.replace(/^راسل|^dm/i, '').replace(/<@!?\d+>/, '').trim();
      if (!text) return message.reply('اكتب الرسالة بعد المنشن.');
      try {
        await target.send(`📩 رسالة من إدارة السيرفر:\n\n${text}`);
        await message.delete().catch(() => {});
        return message.channel.send(`✅ تم إرسال الرسالة لـ **${target.user.username}** بنجاح.`);
      } catch {
        return message.reply('لم أتمكن من الإرسال، العضو قد يكون أغلق الرسائل الخاصة.');
      }
    }

    if (cleanContent === 'قفل' || cleanContent === 'lock') {
      const confirmed = await waitForConfirmation(message, `🔒 هل تريد قفل قناة **${message.channel.name}**؟ اكتب **تأكيد** خلال 10 ثواني.`);
      if (!confirmed) return;
      try {
        await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false });
        return message.channel.send('🔒 تم قفل القناة.');
      } catch { return message.reply('لم أتمكن من قفل القناة.'); }
    }

    if (cleanContent === 'فتح' || cleanContent === 'unlock') {
      const confirmed = await waitForConfirmation(message, `🔓 هل تريد فتح قناة **${message.channel.name}**؟ اكتب **تأكيد** خلال 10 ثواني.`);
      if (!confirmed) return;
      try {
        await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: true });
        return message.channel.send('🔓 تم فتح القناة.');
      } catch { return message.reply('لم أتمكن من فتح القناة.'); }
    }

    if (cleanContent.startsWith('غير اسمي') || cleanContent.startsWith('rename')) {
      const newName = cleanContent.replace(/^غير اسمي|^rename/i, '').trim();
      if (!newName) return message.reply('اكتب الاسم الجديد.');
      const confirmed = await waitForConfirmation(message, `✏️ هل تريد تغيير اسمي إلى **${newName}**؟ اكتب **تأكيد** خلال 10 ثواني.`);
      if (!confirmed) return;
      try {
        await message.guild.members.me.setNickname(newName);
        return message.reply(`✅ تم تغيير اسمي إلى **${newName}** بأمرك سيدي.`);
      } catch { return message.reply('لم أتمكن من تغيير الاسم.'); }
    }

    if (cleanContent.startsWith('غير اسم') || cleanContent.startsWith('nick')) {
      const target = getMentionedMember(message);
      if (!target) return message.reply('حدد العضو بالمنشن.');
      const newName = cleanContent.replace(/^غير اسم|^nick/i, '').replace(/<@!?\d+>/, '').trim();
      if (!newName) return message.reply('اكتب الاسم الجديد بعد المنشن.');
      const confirmed = await waitForConfirmation(message, `✏️ هل تريد تغيير اسم **${target.user.username}** إلى **${newName}**؟ اكتب **تأكيد** خلال 10 ثواني.`);
      if (!confirmed) return;
      try {
        await target.setNickname(newName);
        return message.reply(`✅ تم تغيير اسم **${target.user.username}** إلى **${newName}**.`);
      } catch { return message.reply('لم أتمكن من تغيير الاسم.'); }
    }

    if (cleanContent === 'اغلق' || cleanContent === 'shutdown') {
      const confirmed = await waitForConfirmation(message, '🎩 هل أنت متأكد من إغلاقي سيدي بروس؟ اكتب **تأكيد** خلال 10 ثواني.');
      if (!confirmed) return;
      await message.channel.send('🎩 في أمان الله سيدي بروس. أغلق الآن...');
      process.exit(0);
    }

    if (cleanContent === 'إحصائيات' || cleanContent === 'stats') {
      const guild = message.guild;
      const bots   = guild.members.cache.filter(m => m.user.bot).size;
      const humans = guild.memberCount - bots;
      const totalWarnings = Object.keys(warnData).filter(id => !id.endsWith('_saved_roles')).reduce((a, id) => a + warnData[id].length, 0);
      return message.reply(
        `📊 **إحصائيات السيرفر:**\n` +
        `👥 الأعضاء: **${humans}** بشر + **${bots}** بوت\n` +
        `📺 القنوات: **${guild.channels.cache.size}**\n` +
        `🎭 الرتب: **${guild.roles.cache.size}**\n` +
        `⚠️ إجمالي التحذيرات: **${totalWarnings}**`
      );
    }
  }

  // =====================================================================
  // أوامر إدارية عامة للمشرفين (للأعضاء فقط وليس البوتات)
  // =====================================================================
  if (!message.author.bot) {
    if (cleanContent.startsWith('ميوت') || cleanContent.startsWith('mute')) {
      if (!hasModPermission(message.member)) return message.reply('عذراً، لا تملك صلاحية التكتيم.');
      const target = getMentionedMember(message);
      if (!target) return message.reply('الرجاء تحديد العضو بالمنشن.');
      if (isProtected(message.guild, target.id)) return message.reply('🛡️ لا يمكن تكتيم هذا الشخص.');

      const minutesMatch = cleanContent.match(/(\d+)\s*(دقيقة|دقائق|ساعة|ساعات|يوم|أيام)?/);
      let duration = 10 * 60 * 1000;
      if (minutesMatch) {
        const num = parseInt(minutesMatch[1]);
        if (cleanContent.includes('ساعة') || cleanContent.includes('ساعات')) duration = num * 60 * 60 * 1000;
        else if (cleanContent.includes('يوم') || cleanContent.includes('أيام')) duration = num * 24 * 60 * 60 * 1000;
        else duration = num * 60 * 1000;
      }

      await message.reply(`ما سبب تكتيم **${target.user.username}**؟ (لديك 30 ثانية)`);
      const filter = m => m.author.id === message.author.id;
      let reason = 'لم يُذكر سبب';
      try {
        const collected = await message.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] });
        reason = collected.first().content;
      } catch { return message.channel.send('انتهى الوقت، تم إلغاء التكتيم.'); }
      try {
        await target.timeout(duration, `${reason} | بواسطة ${message.author.tag}`);
        await sendLog(message.guild, `🔇 **ميوت يدوي:** <@${target.id}> | بواسطة: ${message.author.tag} | السبب: ${reason}`);
        return message.reply(`✅ تم تكتيم **${target.user.username}** لمدة ${Math.floor(duration / 60000)} دقيقة.\n📋 **السبب:** ${reason}`);
      } catch { return message.reply('لم أتمكن من تكتيم هذا العضو.'); }
    }

    if (cleanContent.startsWith('فك ميوت') || cleanContent.startsWith('unmute')) {
      if (!hasModPermission(message.member)) return message.reply('عذراً، لا تملك صلاحية فك التكتيم.');
      const target = getMentionedMember(message);
      if (!target) return message.reply('الرجاء تحديد العضو بالمنشن.');
      try {
        await target.timeout(null);
        delete warnData[target.id + '_saved_roles'];
        saveWarnings(warnData);
        return message.reply(`✅ تم فك تكتيم **${target.user.username}**.`);
      } catch { return message.reply('لم أتمكن من فك التكتيم.'); }
    }

    if (cleanContent.startsWith('كيك') || cleanContent.startsWith('طرد') || cleanContent.startsWith('kick')) {
      if (!hasKickPermission(message.member)) return message.reply('عذراً، لا تملك صلاحية الطرد.');
      const target = getMentionedMember(message);
      if (!target) return message.reply('الرجاء تحديد العضو بالمنشن.');
      if (isProtected(message.guild, target.id)) return message.reply('🛡️ لا يمكن طرد هذا الشخص.');
      await message.reply(`ما سبب طرد **${target.user.username}**؟ (لديك 30 ثانية)`);
      const filter = m => m.author.id === message.author.id;
      let reason = 'لم يُذكر سبب';
      try {
        const collected = await message.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] });
        reason = collected.first().content;
      } catch { return message.channel.send('انتهى الوقت، تم إلغاء الطرد.'); }
      try {
        await target.kick(`${reason} | بواسطة ${message.author.tag}`);
        await sendLog(message.guild, `👢 **طرد:** <@${target.id}> | بواسطة: ${message.author.tag} | السبب: ${reason}`);
        return message.reply(`✅ تم طرد **${target.user.username}**.\n📋 **السبب:** ${reason}`);
      } catch { return message.reply('لم أتمكن من طرد هذا العضو.'); }
    }

    if (cleanContent.startsWith('باند') || cleanContent.startsWith('حظر') || cleanContent.startsWith('ban')) {
      if (!hasBanPermission(message.member)) return message.reply('عذراً، لا تملك صلاحية الحظر.');
      const target = getMentionedMember(message);
      if (!target) return message.reply('الرجاء تحديد العضو بالمنشن.');
      if (isProtected(message.guild, target.id)) return message.reply('🛡️ لا يمكن حظر هذا الشخص.');
      await message.reply(`ما سبب حظر **${target.user.username}**؟ (لديك 30 ثانية)`);
      const filter = m => m.author.id === message.author.id;
      let reason = 'لم يُذكر سبب';
      try {
        const collected = await message.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] });
        reason = collected.first().content;
      } catch { return message.channel.send('انتهى الوقت، تم إلغاء الحظر.'); }
      try {
        await target.ban({ reason: `${reason} | بواسطة ${message.author.tag}` });
        await sendLog(message.guild, `🔨 **حظر:** <@${target.id}> | بواسطة: ${message.author.tag} | السبب: ${reason}`);
        return message.reply(`✅ تم حظر **${target.user.username}**.\n📋 **السبب:** ${reason}`);
      } catch { return message.reply('لم أتمكن من حظر هذا العضو.'); }
    }

    if (cleanContent.startsWith('كلير') || cleanContent.startsWith('clear')) {
      if (!isPrivileged(message.author.id) && !message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) {
        return message.reply('عذراً، لا تملك صلاحية حذف الرسائل.');
      }
      const numMatch = cleanContent.match(/\d+/);
      const amount = numMatch ? Math.min(parseInt(numMatch[0]), 100) : 10;
      try {
        await message.channel.bulkDelete(amount, true);
        return message.channel.send(`🗑️ تم حذف ${amount} رسالة.`).then(msg => {
          setTimeout(() => msg.delete().catch(() => {}), 3000);
        });
      } catch { return message.reply('لم أتمكن من حذف الرسائل.'); }
    }

    if (cleanContent.startsWith('تحذير') || cleanContent.startsWith('warn')) {
      if (!hasModPermission(message.member)) return message.reply('عذراً، لا تملك صلاحية إصدار التحذيرات.');
      const target = getMentionedMember(message);
      if (!target) return message.reply('الرجاء تحديد العضو بالمنشن.');
      if (isProtected(message.guild, target.id)) return message.reply('🛡️ لا يمكن تحذير هذا الشخص.');

      await message.reply(`ما سبب تحذير **${target.user.username}**؟ (لديك 30 ثانية)`);
      const filter = m => m.author.id === message.author.id;
      let reason = 'لم يُذكر سبب';
      try {
        const collected = await message.channel.awaitMessages({ filter, max: 1, time: 30000, errors: ['time'] });
        reason = collected.first().content;
      } catch { return message.channel.send('انتهى الوقت، تم إلغاء التحذير.'); }

      await issueEscalatedWarning(message, target.user, reason, message.author.tag);
      return;
    }

    if (cleanContent.startsWith('سجل') || cleanContent.startsWith('warnings')) {
      const target = getMentionedMember(message);
      if (!target) return message.reply('الرجاء تحديد العضو بالمنشن لإظهار سجله.');
      const list = warnData[target.id];
      if (!list || list.length === 0) return message.reply(`✅ **${target.user.username}** ليس لديه أي تحذيرات.`);
      const text = list.map((w, i) => `**${i + 1}.** ${w.reason} — بواسطة ${w.by} (${w.date})`).join('\n');
      return message.reply(`📋 **تحذيرات ${target.user.username}:**\n${text}`);
    }

    if (cleanContent.startsWith('تقرير')) {
      if (!hasModPermission(message.member)) return message.reply('عذراً، لا تملك صلاحية عرض التقارير.');
      const target = getMentionedMember(message);
      if (!target) return message.reply('الرجاء تحديد العضو بالمنشن. مثال: `تقرير @عضو`');

      const list = warnData[target.id] || [];
      const isMuted = target.communicationDisabledUntilTimestamp && target.communicationDisabledUntilTimestamp > Date.now();
      const savedRoles = warnData[target.id + '_saved_roles'] || [];
      const lastViolation = list.length > 0 ? list[list.length - 1] : null;

      let report = `📋 **تقرير العضو ${target.user.username}:**\n\n`;
      report += `🔢 **عدد التحذيرات:** ${list.length}/3\n`;
      report += `🔇 **مكتوم حالياً:** ${isMuted ? 'نعم' : 'لا'}\n`;
      report += `🎭 **رتب محفوظة بانتظار العفو:** ${savedRoles.length}\n`;
      report += `📝 **آخر مخالفة:** ${lastViolation ? `${lastViolation.reason} (${lastViolation.date})` : 'لا يوجد'}\n`;

      return message.reply(report);
    }

    if (cleanContent.startsWith('عفو') && getMentionedMember(message)) {
      if (!isPrivileged(message.author.id) && !hasModPermission(message.member)) {
        return message.reply('عذراً، لا تملك صلاحية العفو.');
      }
      const target = getMentionedMember(message);
      await pardonMember(message, target);
      return;
    }

    if (cleanContent.startsWith('مسح تحذيرات') || cleanContent.startsWith('clearwarns')) {
      if (!hasModPermission(message.member)) return message.reply('عذراً، لا تملك صلاحية مسح التحذيرات.');
      const target = getMentionedMember(message);
      if (!target) return message.reply('الرجاء تحديد العضو بالمنشن.');
      warnData[target.id] = [];
      delete warnData[target.id + '_saved_roles'];
      saveWarnings(warnData);
      return message.reply(`🗑️ تم مسح جميع تحذيرات **${target.user.username}**.`);
    }
  }

  // =====================================================================
  // محادثة ألفريد الذكية
  // =====================================================================
  let isReplyToAlfred = false;
  if (message.reference?.messageId) {
    try {
      const refMsg = await message.channel.messages.fetch(message.reference.messageId);
      if (refMsg.author.id === client.user.id) isReplyToAlfred = true;
    } catch {}
  }

  if (!isMentioned && !isReplyToAlfred) return;

  let userMessage = cleanContent;
  if (!userMessage) {
    const greeting = isPrivileged(message.author.id) ? 'تحت أمرك يا سيدي بروس، كيف يمكنني مساعدتك اليوم؟' : 'نعم، كيف يمكنني مساعدتك؟';
    return message.reply(greeting);
  }

  await message.channel.sendTyping();
  setTimeout(async () => {
    const reply = await getAlfredReply(message.channel.id, message.author.id, message.author.username, userMessage);
    message.reply(reply);
  }, 1500);
});

client.login(process.env.ALFRED_TOKEN);