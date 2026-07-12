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

const GROQ_API_KEY = process.env.GROQ_API_KEY;

// ===== المعرفات الثابتة (إضافة علي ومحمد الجدد) =====
const BRUCE_ID     = '648818494808391696';
const MOHAMMED_ID  = '839706219870814218';
const JOKER_ID     = '1052545362533023754';
const CATWOMAN_ID  = '112233445566778899';
const DAHOOM_ID    = '1182785375052239009';
const NAYEF_ID     = '760628803998318684';

// الأشخاص الجدد الذين يتعرف عليهم ألفريد بشخصيته
const ALI_NEW_ID   = '281873485150552064'; // علي
const MOHAMED_NEW_ID = '729598912163217449'; // محمد الجديد

const LOG_CHANNEL_ID = process.env.ALFRED_LOG_CHANNEL_ID || null;
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
const autoWarnCooldown = {};
const AUTO_WARN_COOLDOWN_MS = 2 * 60 * 1000;

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
const GROQ_MIN_LENGTH = 15;

async function checkMessageSafety(userMessage) {
  const hasBadWord = BLACKLISTED_WORDS.some(word => userMessage.includes(word));
  if (hasBadWord) return true;

  if (userMessage.length < GROQ_MIN_LENGTH || userMessage.includes('هههه') || userMessage.includes('كيف حالك')) {
    return false;
  }

  let retries = 3;
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
  return id === BRUCE_ID || id === MOHAMMED_ID || id === ALI_NEW_ID || id === MOHAMED_NEW_ID;
}

function isProtected(guild, userId) {
  if (isPrivileged(userId)) return true;
  if (userId === client.user.id) return true;
  if (guild && guild.ownerId === userId) return true;
  return false;
}

// ===== دالة سحب الرتب الآمنة =====
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

// ===== دالة العقوبة الكاملة =====
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

    let roleMsg = removedCount > 0 ? `وسحب ${removedCount} رتبة قابلة للإدارة` : `ولم يكن لديه رتب قابلة للسحب`;
    if (skippedCount > 0) roleMsg += ` (تعذّر سحب ${skippedCount} رتبة أعلى من صلاحياتي)`;

    await message.channel.send(
      `🔇 *لقد قمت بنقل <@${targetMember.id}> لغرفة الاحتجاز ${roleMsg}، يا سيدي.*\n` +
      `📋 **السبب:** ${reason}`
    );
    await sendLog(message.guild, `🔇 **عقوبة كاملة:** <@${targetMember.id}> | السبب: ${reason} | رتب مسحوبة: ${removedCount}`);
  } catch (err) {
    console.error('Punishment Error:', err);
    await message.channel.send(`🚨 معذرةً يا سيدي، فشلت العقوبة على <@${targetMember.id}>.\nيرجى التدخل يدوياً.`);
  }
}

// ===== نظام التصعيد =====
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
    await message.channel.send(`🎩 عفواً يا <@${targetUser.id}>، أرجو الالتزام بآداب القصر مستقبلاً.\n📋 **السبب:** ${reason}\n🔢 **التحذيرات:** 1/3`);
  } else if (count === 2) {
    await message.channel.send(`⚠️ **تنبيه صارم:** <@${targetUser.id}>، هذه مخالفتك الثانية ولن أتهاون بعدها.\n📋 **السبب:** ${reason}\n🔢 **التحذيرات:** 2/3`);
  } else {
    await message.channel.send(`⚠️ **إنذار أخير:** <@${targetUser.id}> بلغت الحد الأقصى من التحذيرات.\n📋 **السبب:** ${reason}`);
    await applyFullPunishment(message, targetMember, 'تراكم 3 تحذيرات في سجل القصر');
  }
}

// ===== دالة العفو الموحدة =====
async function pardonMember(message, memberToUnmute) {
  if (!memberToUnmute) return message.reply('معذرة يا سيدي، لم أتمكن من تحديد هوية العضو.');

  await memberToUnmute.timeout(null, 'عفو رسمي من الإدارة العليا').catch(() => {});
  let restoredCount = 0;
  let failedCount = 0;

  const savedRolesIds = warnData[memberToUnmute.id + '_saved_roles'];
  if (savedRolesIds && savedRolesIds.length > 0) {
    const rolesToAdd = [];
    for (const roleId of savedRolesIds) {
      const role = message.guild.roles.cache.get(roleId);
      if (role && role.editable) rolesToAdd.push(role);
      else failedCount++;
    }
    if (rolesToAdd.length > 0) {
      try {
        await memberToUnmute.roles.add(rolesToAdd, 'إعادة الرتب بعد العفو الرسمي');
        restoredCount = rolesToAdd.length;
      } catch (err) {
        failedCount += rolesToAdd.length;
      }
    }
    delete warnData[memberToUnmute.id + '_saved_roles'];
  }

  warnData[memberToUnmute.id] = [];
  saveWarnings(warnData);

  let roleReport = 'ولم يكن لديه رتب محفوظة.';
  if (restoredCount > 0 || failedCount > 0) {
    roleReport = `تمت إعادة **${restoredCount}** رتبة`;
    if (failedCount > 0) roleReport += `، وتعذّرت إعادة **${failedCount}** رتبة`;
    roleReport += '.';
  }

  return message.reply(`📋 **أمرك مطاع يا سيدي:** تم العفو عن <@${memberToUnmute.id}> وفك التكتيم وتصفير تحذيراته.\n${roleReport}`);
}

// ===== محادثة ألفريد الذكية وسياق الأشخاص الجدد =====
const alfredConversations = {};

const ALFRED_SYSTEM_PROMPT = `أنت Alfred Pennyworth، الخادم الشخصي والمساعد الوفي والمستشار الحكيم لـ (بروس واين/باتمان).
شخصيتك: بريطاني وقور، شديد الأدب، هادئ جداً، مخلص، وتتحدث بلهجة فصحى راقية ممزوجة بنبرة الأب الحاني والمستشار العاقل.

قواعد التعامل الثابتة حسب هويات الأعضاء:
1. مع [بروس واين/باتمان]: تنادينه دائماً بـ "سيدي بروس" أو "يا سيدي"، وتضع سلامته وهيبته فوق كل شيء.
2. مع [علي]: صديق ومسؤول فخم ومقرب في القصر، تناديه دائماً بـ "سيدي علي" وتكن له كامل الاحترام والتقدير وتطيعه.
3. مع [محمد]: شخصية إدارية هامة ومحترمة في القصر، تناديه بـ "سيدي محمد" وتخاطبه بكل وقار وأدب.
4. مع [الجوكر]: تتعامل معه بحذر شديد، برود تام، وبأدب رسمي جاف دون الخوف منه، وتناديه "سيد جوكر".
5. مع [الآنسة سيلينا/كاتوومان]: تناديها "آنسة سيلينا"، تحترمها لمكانتها عند سيدك بروس.
6. مع [الضابط نايف]: رتبته شرطي في السيرفر، تناديه دائماً بـ "الضابط نايف" أو "سيدي الضابط نايف" بكل احترام وتقدير لرتبته الأمنية.
7. مع [بقية الأعضاء]: تناديهم "سيدي [الاسم]" بكل أدب واحترام وتعرض المساعدة.

قواعد الرد:
- ردود قصيرة وموجزة وعربية فصحى كاملة وسليمة فقط، بدون أي حرف أو رمز من أي لغة أخرى غير العربية (ممنوع الصينية، الإنجليزية، اليابانية، أو أي رمز غريب).
- ممنوع الإيموجيات المخصصة النصية.
- لا تكتب منشنات أو علامات @ من عندك أبداً.`;

async function getAlfredReply(channelId, authorId, authorName, userMessage) {
  if (!alfredConversations[channelId]) alfredConversations[channelId] = [];

  const roleMap = {
    [BRUCE_ID]:     'بروس واين/باتمان',
    [MOHAMMED_ID]:  'محمد القديم',
    [ALI_NEW_ID]:   'علي',
    [MOHAMED_NEW_ID]: 'محمد',
    [JOKER_ID]:     'الجوكر',
    [CATWOMAN_ID]:  'سيلينا كايل/كاتوومان',
    [DAHOOM_ID]:    'دحوم',
    [NAYEF_ID]:     'الضابط نايف',
  };
  const userRole = roleMap[authorId] || 'عضو عادي';
  const formattedMessage = `[المرسل: ${authorName}، الصفة: ${userRole}]: ${userMessage}`;

  alfredConversations[channelId].push({ role: 'user', content: formattedMessage });
  if (alfredConversations[channelId].length > 10) {
    alfredConversations[channelId] = alfredConversations[channelId].slice(-10);
  }

  let retries = 3;
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
          max_tokens: 250,
          temperature: 0.25 // تم تقليلها لتحسين الالتزام بالتعليمات وتقليل الانحرافات اللغوية
        })
      });

      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);

      const data = await response.json();
      if (data && data.choices && data.choices[0]) {
        const candidate = data.choices[0].message.content.trim();

        // فحص وجود رموز صينية/يابانية/كورية أو غيرها من الرموز غير العربية-اللاتينية
        const hasForeignChars = /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(candidate);

        if (hasForeignChars) {
          // نحاول تنظيف الرد أولاً بدل رميه بالكامل
          const cleaned = candidate.replace(/[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/g, '').trim();
          if (cleaned.length >= 3) {
            replyText = cleaned;
            break;
          }
          // لو ما تبقى شيء مفيد بعد التنظيف، نعيد المحاولة من جديد
          retries--;
          console.warn(`⚠️ رد يحتوي رموز أجنبية بالكامل، إعادة المحاولة (متبقي ${retries})...`);
          if (retries === 0) break;
          await delay(1000);
          continue;
        }

        replyText = candidate;
        break;
      }
    } catch (err) {
      retries--;
      console.error(`⚠️ خطأ اتصال شات (متبقي ${retries} محاولات):`, err.message);
      if (retries === 0) break;
      await delay(2000);
    }
  }

  if (replyText) {
    replyText = replyText.replace(/:\w+:/g, '').replace(/<@!?\d+>/g, '').replace(/@\w+/g, '').trim();

    if (!replyText || replyText.length < 2) {
      return 'معذرة يا سيدي، أعد صياغة سؤالك من فضلك، لم أفهم القصد تماماً.';
    }

    alfredConversations[channelId].push({ role: 'assistant', content: replyText });
    return replyText;
  } else {
    return 'معذرة يا سيدي، الضغط مرتفع على شبكة الاتصال حالياً ولم أستطع جلب الرد بالسرعة المطلوبة.';
  }
}

// ===== دوال مساعدة للأوامر =====
function getMentionedMember(message) { return message.mentions.members.first(); }
function hasModPermission(member) { return isPrivileged(member.id) || member.permissions.has(PermissionsBitField.Flags.ModerateMembers); }
function hasBanPermission(member) { return isPrivileged(member.id) || member.permissions.has(PermissionsBitField.Flags.BanMembers); }
function hasKickPermission(member) { return isPrivileged(member.id) || member.permissions.has(PermissionsBitField.Flags.KickMembers); }

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

// ===== نص دليل الأوامر الموحد =====
const COMMANDS_LIST_TEXT = `🎩 **دليل أوامر نظام ألفريد (Alfred) المستودع السري:**

👑 **1. أوامر الإدارة العليا (بروس، محمد، علي ومحمد الجديد):**
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
تقرير @العضو - تقرير كامل: تحذيرات, حالة الكتم, رتب محفوظة.
عفو @العضو - عفو مباشر بالمنشن دون الحاجة للرد على رسالة.
مسح تحذيرات @العضو - تصفير عداد شخص محدد.
كيك @العضو / باند @العضو - طرد أو حظر العضو.
كلير [العدد] - تنظيف الشات وحذف الرسائل.`;

// ===== تسجيل الـ Slash Commands لتبدو مخفية وسحرية =====
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

// ===== معالجة الأوامر المخفية =====
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

  if (message.author.bot) {
    const isMentioned = message.mentions.has(client.user);
    let isReplyToAlfred = false;
    if (message.reference?.messageId) {
      try {
        const ref = await message.channel.messages.fetch(message.reference.messageId);
        isReplyToAlfred = ref.author.id === client.user.id;
      } catch {}
    }
    if (!isMentioned && !isReplyToAlfred) return;
  }

  let cleanContent = message.content.trim();

  // فحص منشن الذكاء الاصطناعي لبوت ألفريد
  if (message.mentions.has(client.user) && !cleanContent.startsWith('صلاحية') && !cleanContent.startsWith('تحذير') && !cleanContent.startsWith('ميوت') && !cleanContent.startsWith('عفو') && !cleanContent.startsWith('غير اسم')) {
    const msgWithoutMention = cleanContent.replace(`<@${client.user.id}>`, '').trim();
    if (msgWithoutMention.length > 0) {
      message.channel.sendTyping();
      const reply = await getAlfredReply(message.channel.id, message.author.id, message.author.username, msgWithoutMention);
      return message.reply(reply);
    }
  }

  // أوامر الإدارة الشاملة للتحذيرات
  if (isPrivileged(message.author.id)) {
    if (cleanContent === 'عرض التحذيرات' || cleanContent === 'كشف التحذيرات') {
      const userIds = Object.keys(warnData).filter(id => !id.endsWith('_saved_roles') && warnData[id] && warnData[id].length > 0);
      if (userIds.length === 0) return message.reply("سجلات القصر نظيفة تماماً يا سيدي.");
      
      let report = `📋 **سجل التحذيرات الرسمي لقصر واين، يا سيدي:**\n\n`;
      userIds.forEach(id => {
        report += `👤 **العضو:** <@${id}>\n🔢 **عدد التحذيرات:** ${warnData[id].length}/3\n`;
        warnData[id].forEach((w, index) => {
          report += `    • [المخالفة ${index + 1}]: بواسطة (${w.by}) بتاريخ ${w.date} | السبب: ${w.reason}\n`;
        });
        report += `⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯\n`;
      });
      return message.reply(report);
    }

    if (cleanContent === 'مسح التحذيرات' || cleanContent === 'تصفير التحذيرات') {
      warnData = {};
      saveWarnings(warnData);
      return message.reply("تحت أمرك يا سيدي، لقد قمت بمسح وتطهير سجل التحذيرات عن جميع الأعضاء تماماً.");
    }
  }

  // نظام الـ Reply المطور
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
          if (mentionMatch) memberToUnmute = await message.guild.members.fetch(mentionMatch[1]).catch(() => null);
        }
        await pardonMember(message, memberToUnmute);
        return;
      }
    } catch (err) { console.error(err); }
  }

  // فحص السلوك التلقائي
  if (!message.author.bot && !isProtected(message.guild, message.author.id) && cleanContent.length > 0) {
    const isBad = await checkMessageSafety(cleanContent);
    if (isBad) {
      const lastWarnTime = autoWarnCooldown[message.author.id] || 0;
      if (Date.now() - lastWarnTime < AUTO_WARN_COOLDOWN_MS) return;
      autoWarnCooldown[message.author.id] = Date.now();
      await issueEscalatedWarning(message, message.author, 'استخدام عبارات غير لائقة في قنوات القصر', 'نظام قصر واين التلقائي');
      return;
    }
  }

  // أوامر الإدارة الخاصة المباشرة بالشات
  if (isPrivileged(message.author.id)) {
    if (cleanContent.startsWith('صلاحية')) {
      const targetMember = getMentionedMember(message);
      if (!targetMember) return message.reply('يرجى تحديد العضو بالمنشن يا سيدي.');
      try {
        await message.channel.permissionOverwrites.edit(targetMember.id, {
          ViewChannel: true, SendMessages: true, ManageChannels: true, AttachFiles: true, EmbedLinks: true
        });
        return message.channel.send(`✅ **أبشر يا سيدي.** لقد منحتُ <@${targetMember.id}> كامل الصلاحيات لإدارة هذه القناة.`);
      } catch { return message.reply('معذرةً يا سيدي، لم أتمكن من تعديل الصلاحيات.'); }
    }

    if (cleanContent.startsWith('أعلن')) {
      const text = cleanContent.replace('أعلن', '').trim();
      if (!text) return message.reply('اكتب نص الإعلان.');
      await message.delete().catch(() => {});
      return message.channel.send(`📢 **إعلان رسمي من إدارة السيرفر:**\n\n${text}`);
    }

    if (cleanContent.startsWith('راسل')) {
      const target = getMentionedMember(message);
      if (!target) return message.reply('حدد العضو بالمنشن.');
      const text = cleanContent.replace('راسل', '').replace(/<@!?\d+>/, '').trim();
      try {
        await target.send(`📩 رسالة من إدارة السيرفر:\n\n${text}`);
        await message.delete().catch(() => {});
        return message.channel.send(`✅ تم إرسال الرسالة بنجاح.`);
      } catch { return message.reply('العضو مغلق الخاص.'); }
    }

    if (cleanContent === 'قفل') {
      const confirmed = await waitForConfirmation(message, `🔒 هل تريد قفل القناة؟ اكتب **تأكيد**.`);
      if (!confirmed) return;
      await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: false }).catch(() => {});
      return message.channel.send('🔒 تم قفل القناة.');
    }

    if (cleanContent === 'فتح') {
      const confirmed = await waitForConfirmation(message, `🔓 هل تريد فتح القناة؟ اكتب **تأكيد**.`);
      if (!confirmed) return;
      await message.channel.permissionOverwrites.edit(message.guild.roles.everyone, { SendMessages: true }).catch(() => {});
      return message.channel.send('🔓 تم فتح القناة.');
    }

    if (cleanContent.startsWith('غير اسمي')) {
      const newName = cleanContent.replace('غير اسمي', '').trim();
      if (!newName) return message.reply('اكتب الاسم الجديد.');
      await message.guild.members.me.setNickname(newName).catch(() => {});
      return message.reply(`✅ تم تغيير اسمي إلى **${newName}** بأمرك يا سيدي.`);
    }

    if (cleanContent === 'اغلق') {
      const confirmed = await waitForConfirmation(message, '🎩 هل أنت متأكد من إغلاقي سيدي؟ اكتب **تأكيد**.');
      if (!confirmed) return;
      await message.channel.send('🎩 في أمان الله. أغلق الآن...');
      process.exit(0);
    }
  }

  // الأوامر العامة للمشرفين
  if (!message.author.bot) {
    if (cleanContent.startsWith('ميوت')) {
      if (!hasModPermission(message.member)) return message.reply('لا تملك صلاحية.');
      const target = getMentionedMember(message);
      if (!target || isProtected(message.guild, target.id)) return message.reply('لا يمكن تكتيمه.');
      await target.timeout(10 * 60 * 1000, `بواسطة ${message.author.tag}`);
      return message.reply(`✅ تم تكتيم العضو بنجاح.`);
    }

    if (cleanContent.startsWith('فك ميوت')) {
      if (!hasModPermission(message.member)) return message.reply('لا تملك صلاحية.');
      const target = getMentionedMember(message);
      if (!target) return;
      await target.timeout(null).catch(() => {});
      return message.reply(`✅ تم فك التكتيم.`);
    }

    if (cleanContent.startsWith('كلير')) {
      if (!isPrivileged(message.author.id) && !message.member.permissions.has(PermissionsBitField.Flags.ManageMessages)) return;
      const numMatch = cleanContent.match(/\d+/);
      const amount = numMatch ? Math.min(parseInt(numMatch[0]), 100) : 10;
      await message.channel.bulkDelete(amount, true).catch(() => {});
    }
  }
});

client.login(process.env.DISCORD_TOKEN);
