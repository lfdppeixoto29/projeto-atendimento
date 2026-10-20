const express = require('express');
const fetch = require('node-fetch');
require('dotenv').config();

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 3000;
const EVOLUTION_API_URL = process.env.EVOLUTION_API_URL;
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY;
const INSTANCE_NAME = process.env.INSTANCE_NAME || 'atendimento_principal';

// Armazenamento em memória dos estados dos clientes (numero_telefone -> estado)
// Estados possíveis: 
// - 'MENU' (Aguardando escolher opção 1, 2 ou 3)
// - 'ATENDIMENTO_HUMANO' (Liberado para conversar livremente / atendente)
const userStates = new Map();

// Textos dos Menus e Respostas
const MENU_TEXT = 
`🤖 *Olá! Seja bem-vindo(a) ao nosso atendimento automático.*

Para continuarmos, por favor escolha uma das opções abaixo digitando apenas o número correspondente:

1️⃣ - Falar sobre Produtos e Preços
2️⃣ - Suporte Técnico / Dúvidas
3️⃣ - Falar com Atendente (Humano / IA Livre)`;

const OPCAO_1_TEXT = 
`📦 *Nossos Produtos e Preços:*
Temos soluções completas para o seu negócio.
- Plano Starter: R$ 97/mês
- Plano Pro: R$ 197/mês

Digite *#* a qualquer momento para voltar ao menu principal.`;

const OPCAO_2_TEXT = 
`🛠️ *Suporte Técnico:*
Nosso horário de atendimento é de Segunda a Sexta, das 09h às 18h.
Envie sua dúvida detalhada ou aguarde nosso contato.

Digite *#* a qualquer momento para voltar ao menu principal.`;

const OPCAO_3_TEXT = 
`👤 *Atendimento Humano / Especialista Ativado!*
A partir de agora você está conectado com nosso atendente. Pode enviar sua mensagem livremente.

*(Para retornar ao menu automático, digite #menu)*`;

// Função para enviar mensagem via Evolution API
async function sendWhatsAppMessage(remoteJid, text) {
  try {
    const url = `${EVOLUTION_API_URL}/message/sendText/${INSTANCE_NAME}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': EVOLUTION_API_KEY
      },
      body: JSON.stringify({
        number: remoteJid.replace('@s.whatsapp.net', ''),
        text: text
      })
    });
    const data = await response.json();
    console.log(`[ENVIO] Mensagem enviada para ${remoteJid}:`, data);
  } catch (err) {
    console.error(`[ERRO ENVIO] Falha ao enviar mensagem para ${remoteJid}:`, err.message);
  }
}

// Rota de Webhook para receber as mensagens do WhatsApp da Evolution API
app.post('/webhook', async (req, res) => {
  try {
    const body = req.body;
    console.log('[WEBHOOK RECEBIDO]', JSON.stringify(body, null, 2));

    // Validar se é uma mensagem válida vinda do WhatsApp
    if (body.event !== 'messages.upsert' && body.event !== 'MESSAGES_UPSERT') {
      return res.status(200).send({ status: 'ignored_event' });
    }

    const messageData = body.data;
    if (!messageData || !messageData.message) {
      return res.status(200).send({ status: 'no_message_data' });
    }

    // Ignorar mensagens enviadas por nós mesmos (fromMe)
    if (messageData.key && messageData.key.fromMe) {
      return res.status(200).send({ status: 'ignored_from_me' });
    }

    const remoteJid = messageData.key.remoteJid;
    // Extrair o texto da mensagem (pode vir em conversation ou extendedTextMessage)
    const msgContent = messageData.message;
    const textMessage = 
      msgContent.conversation || 
      msgContent.extendedTextMessage?.text || 
      msgContent.imageMessage?.caption || 
      '';

    const cleanText = textMessage.trim();
    if (!cleanText) {
      return res.status(200).send({ status: 'empty_text' });
    }

    console.log(`[MENSAGEM] De ${remoteJid}: "${cleanText}"`);

    // Obter estado atual do cliente
    let currentState = userStates.get(remoteJid) || 'MENU';

    // Comando universal para voltar ao menu
    if (cleanText === '#' || cleanText.toLowerCase() === '#menu') {
      userStates.set(remoteJid, 'MENU');
      await sendWhatsAppMessage(remoteJid, `🔄 Retornando ao menu principal...\n\n` + MENU_TEXT);
      return res.status(200).send({ status: 'success', action: 'returned_to_menu' });
    }

    // Se o cliente já escolheu a opção 3 (Atendimento Humano / Conversa Livre)
    if (currentState === 'ATENDIMENTO_HUMANO') {
      console.log(`[ATENDIMENTO LIVRE] Cliente ${remoteJid} está em atendimento humano. Mensagem ignorada pelo bot automático.`);
      // Aqui você pode integrar IA ou deixar para o atendente humano responder no WhatsApp
      return res.status(200).send({ status: 'success', action: 'human_mode_active' });
    }

    // Se o cliente está no ESTADO 'MENU', ele SÓ pode avançar se digitar 1, 2 ou 3 estritamente
    if (currentState === 'MENU') {
      if (cleanText === '1') {
        await sendWhatsAppMessage(remoteJid, OPCAO_1_TEXT);
        // Opcional: mantemos no menu ou mantemos esperando
        return res.status(200).send({ status: 'success', action: 'option_1' });
      } 
      else if (cleanText === '2') {
        await sendWhatsAppMessage(remoteJid, OPCAO_2_TEXT);
        return res.status(200).send({ status: 'success', action: 'option_2' });
      } 
      else if (cleanText === '3') {
        userStates.set(remoteJid, 'ATENDIMENTO_HUMANO');
        await sendWhatsAppMessage(remoteJid, OPCAO_3_TEXT);
        return res.status(200).send({ status: 'success', action: 'option_3_human' });
      } 
      else {
        // BLOQUEIO RIGOROSO: Qualquer outra coisa que digitar repete o menu e impede conversa livre
        const bloqueioMsg = `⚠️ *Opção inválida!*\n\nPor favor, digite apenas o número correspondente à opção desejada (1, 2 ou 3):\n\n` + MENU_TEXT;
        await sendWhatsAppMessage(remoteJid, bloqueioMsg);
        return res.status(200).send({ status: 'success', action: 'invalid_option_blocked' });
      }
    }

    res.status(200).send({ status: 'success' });
  } catch (err) {
    console.error('[ERRO NO WEBHOOK]:', err);
    res.status(500).send({ error: err.message });
  }
});

// Rota de teste para ver se o servidor está no ar
app.get('/', (req, res) => {
  res.send({ status: 'online', service: 'Atendimento WhatsApp Webhook' });
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
});
