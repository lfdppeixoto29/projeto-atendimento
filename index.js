const express = require('express');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const INSTANCE_NAME = process.env.INSTANCE_NAME || 'atendimento_principal';

// Armazenamento em memória dos estados dos clientes
// remoteJid -> { mode: 'INICIAL' | 'COLETANDO_DADOS' | 'EMPRESA_MENU' | 'PARTICULAR' }
const userStates = new Map();

// Configurações do Atendimento
const config = {
  openaiApiKey: process.env.OPENAI_API_KEY || "",
  aiPrompt: "Você é um assistente virtual prestativo e educado. Responda de forma clara e objetiva.",

  empresaHeader: "🏢 *Atendimento Corporativo (Empresa)*",
  solicitarDadosMsg: "Para iniciarmos o atendimento da sua empresa, por favor informe:\n1️⃣ *Nome da Empresa*\n2️⃣ *CNPJ*\n\n*(Responda enviando os dados em uma única mensagem)*",
  sucessoDadosMsg: "✅ *Dados cadastrados com sucesso!*",

  menuEmpresaHeader: "📋 *Menu da Empresa - Escolha uma opção:*",
  item1: "1️⃣ - Comercial / Orçamentos",
  resp1: "📦 *Comercial:* Nossos consultores vão analisar sua solicitação.",
  item2: "2️⃣ - Suporte Técnico",
  resp2: "🛠️ *Suporte Técnico:* Descreva o problema enfrentado.",
  item3: "3️⃣ - Financeiro",
  resp3: "💰 *Financeiro:* Envie sua solicitação de faturamento.",

  falhaMsg: "❌ *Opção inválida!* Digite obrigatoriamente 1, 2 ou 3 para prosseguir.",
  configTrigger: "#config",
  configResp: "⚙️ *Painel Administrativo da Empresa Ativo.*",
  particularIntro: "🤖 *Atendimento Particular ativado!* A partir de agora nossa Inteligência Artificial vai conversar com você."
};

// Função para enviar mensagem via Evolution API
async function sendWhatsAppMessage(number, text) {
  try {
    const url = `${EVOLUTION_API_URL}/message/sendText/${INSTANCE_NAME}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': EVOLUTION_API_KEY
      },
      body: JSON.stringify({
        number: number.replace('@s.whatsapp.net', ''),
        text: text
      })
    });
    const data = await response.json();
    console.log(`[ENVIO] Mensagem enviada para ${number}:`, data);
  } catch (err) {
    console.error(`[ERRO ENVIO] Falha ao enviar para ${number}:`, err.message);
  }
}

// Função para chamar a IA (OpenAI GPT)
async function askAI(userMessage) {
  if (!config.openaiApiKey) return "⚠️ Chave da API OpenAI não configurada no servidor.";
  try {
    const response = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${config.openaiApiKey}`
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        messages: [
          { role: "system", content: config.aiPrompt },
          { role: "user", content: userMessage }
        ],
        temperature: 0.7
      })
    });
    const data = await response.json();
    return data.choices?.[0]?.message?.content || "Desculpe, não consegui processar sua resposta no momento.";
  } catch (err) {
    console.error('[ERRO IA]:', err);
    return "Desculpe, ocorreu um erro ao consultar a inteligência artificial.";
  }
}

// Rota de Webhook para receber mensagens da Evolution API
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('[WEBHOOK RECEBIDO]', JSON.stringify(body, null, 2));

    if (body.event !== 'messages.upsert' && body.event !== 'MESSAGES_UPSERT') {
      return res.status(200).send({ status: 'ignored_event' });
    }

    const messageData = body.data;
    if (!messageData || !messageData.message) {
      return res.status(200).send({ status: 'no_message_data' });
    }

    if (messageData.key && messageData.key.fromMe) {
      return res.status(200).send({ status: 'ignored_from_me' });
    }

    const remoteJid = messageData.key.remoteJid;
    const msgContent = messageData.message;
    const textMessage = 
      msgContent.conversation || 
      msgContent.extendedTextMessage?.text || 
      '';

    const cleanText = textMessage.trim();
    if (!cleanText) return res.status(200).send({ status: 'empty_text' });

    let session = userStates.get(remoteJid) || { mode: 'INICIAL' };

    // Comando universal para voltar ao menu
    if (cleanText === '#' || cleanText.toLowerCase() === '#menu') {
      userStates.set(remoteJid, { mode: 'INICIAL' });
      const menuInicial = 
        `🤖 *Olá! Seja bem-vindo(a).*\n\nComo deseja ser atendido?\n\n` +
        `1️⃣ - Empresa (Exige dados e menu obrigatório)\n` +
        `2️⃣ - Particular (Atendimento livre com IA)`;
      await sendWhatsAppMessage(remoteJid, menuInicial);
      return res.status(200).send({ status: 'success', action: 'returned_to_menu' });
    }

    // 1. Modo PARTICULAR -> Conversa livre com IA
    if (session.mode === 'PARTICULAR') {
      const aiResponse = await askAI(cleanText);
      await sendWhatsAppMessage(remoteJid, aiResponse);
      return res.status(200).send({ status: 'success', action: 'ai_response' });
    }

    // 2. Modo COLETANDO_DADOS (Empresa) -> Obrigatório informar dados antes de entrar no menu
    if (session.mode === 'COLETANDO_DADOS') {
      session.dadosEmpresa = cleanText;
      session.mode = 'EMPRESA_MENU';
      userStates.set(remoteJid, session);

      const menuEmpresa = 
        `${config.sucessoDadosMsg}\n\n${config.menuEmpresaHeader}\n` +
        `${config.item1}\n${config.item2}\n${config.item3}\n\n` +
        `*(Digite o número da opção desejada ou # para voltar)*`;
      
      await sendWhatsAppMessage(remoteJid, menuEmpresa);
      return res.status(200).send({ status: 'success', action: 'data_collected' });
    }

    // 3. Modo EMPRESA_MENU -> Menu estrito com itens 1 a 3 obrigatórios + Falha + Config
    if (session.mode === 'EMPRESA_MENU') {
      if (cleanText.toLowerCase() === config.configTrigger.toLowerCase()) {
        await sendWhatsAppMessage(remoteJid, config.configResp + "\n\n*(Digite # para voltar)*");
        return res.status(200).send({ status: 'success', action: 'config_triggered' });
      }

      if (cleanText === '1') {
        await sendWhatsAppMessage(remoteJid, config.resp1.replace(/\\n/g, '\n') + "\n\n*(Digite # para voltar)*");
      } else if (cleanText === '2') {
        await sendWhatsAppMessage(remoteJid, config.resp2.replace(/\\n/g, '\n') + "\n\n*(Digite # para voltar)*");
      } else if (cleanText === '3') {
        await sendWhatsAppMessage(remoteJid, config.resp3.replace(/\\n/g, '\n') + "\n\n*(Digite # para voltar)*");
      } else {
        const menuEmpresa = 
          `${config.menuEmpresaHeader}\n` +
          `${config.item1}\n${config.item2}\n${config.item3}\n\n` +
          `⚠️ *(Digite # para voltar ao início)*`;

        await sendWhatsAppMessage(remoteJid, `${config.falhaMsg}\n\n` + menuEmpresa);
      }
      return res.status(200).send({ status: 'success', action: 'menu_empresa' });
    }

    // 4. Modo INICIAL (Escolha Empresa vs. Particular)
    if (session.mode === 'INICIAL') {
      if (cleanText === '1') {
        session.mode = 'COLETANDO_DADOS';
        userStates.set(remoteJid, session);
        await sendWhatsAppMessage(remoteJid, `${config.empresaHeader}\n\n${config.solicitarDadosMsg}`);
      } 
      else if (cleanText === '2') {
        session.mode = 'PARTICULAR';
        userStates.set(remoteJid, session);
        await sendWhatsAppMessage(remoteJid, config.particularIntro);
      } 
      else {
        const menuInicial = 
          `❌ *Opção inválida!*\n\nEscolha como deseja ser atendido:\n\n` +
          `1️⃣ - Empresa (Exige dados e menu obrigatório)\n` +
          `2️⃣ - Particular (Atendimento livre com IA)`;
        await sendWhatsAppMessage(remoteJid, menuInicial);
      }
      return res.status(200).send({ status: 'success', action: 'initial_choice' });
    }

    res.status(200).send({ status: 'success' });
  } catch (err) {
    console.error('[ERRO NO WEBHOOK]:', err);
    res.status(500).send({ error: err.message });
  }
});

app.get('/', (req, res) => {
  res.send({ status: 'online', service: 'Atendimento WhatsApp Webhook (Evolution API)' });
});

app.listen(PORT, () => {
  console.log(`Webhook rodando na porta ${PORT}`);
});
