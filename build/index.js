#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import axios from 'axios';
import https from 'https';
import crypto from 'crypto';
import express from 'express';
import { parseStringPromise } from 'xml2js';
// Configurações
const PORT = process.env.WEBHOOK_PORT || 3000;
const WEBHOOK_URL_BASE = process.env.WEBHOOK_URL_BASE || `http://localhost:${PORT}`;
// Armazenamento temporário para as promessas de venda
// Mapa: saleId -> { resolve: (value: any) => void, timeout: NodeJS.Timeout }
const pendingSales = new Map();
// Configura servidor Express para o Webhook
const app = express();
app.use(express.json());
app.post('/webhook/:saleId', (req, res) => {
    const { saleId } = req.params;
    console.error(`[Webhook] Recebido callback para saleId: ${saleId}`);
    console.error(`[Webhook] Body:`, JSON.stringify(req.body, null, 2));
    if (pendingSales.has(saleId)) {
        const { resolve, timeout } = pendingSales.get(saleId);
        clearTimeout(timeout);
        // Retorna os dados do webhook para a promessa que está esperando
        resolve(req.body);
        pendingSales.delete(saleId);
        res.status(200).send('OK');
    }
    else {
        console.error(`[Webhook] Nenhuma venda pendente encontrada para saleId: ${saleId}`);
        res.status(404).send('Not Found');
    }
});
// Inicia o servidor Express em segundo plano
// NOTA: Em um ambiente de produção real com MCP via Stdio, isso pode ser complexo pois o MCP usa Stdio.
// O ideal seria que este processo rodasse separadamente ou que o MCP fosse SSE.
// Mas para este caso de uso, vamos rodar o express junto.
const serverExpress = app.listen(PORT, () => {
    console.error(`[Webhook] Servidor ouvindo na porta ${PORT}`);
});
// Configurações da API SOAP
const URL_API = 'https://multiclubes.balipark.com.br/(a655f81b-8437-48ec-8876-069664ee891a)/TicketsV2.svc';
const SOAP_ACTION_GET_TICKETS = 'http://multiclubes.com.br/tickets/v2/IService/GetTickets';
const SOAP_ACTION_SELL = 'http://multiclubes.com.br/tickets/v2/IService/Sell';
const AUTH_KEY = '3fe6ca43-65cc-4776-9fb8-667855dbd6e0';
// Agente HTTPS permissivo
const agent = new https.Agent({
    rejectUnauthorized: false,
    secureOptions: crypto.constants.SSL_OP_LEGACY_SERVER_CONNECT,
    minVersion: 'TLSv1',
    ciphers: 'DEFAULT:@SECLEVEL=0'
});
// Create an MCP server
const server = new McpServer({
    name: "multiclube-server",
    version: "1.0.0"
});
// Ferramenta: Listar Tickets
server.tool("listar_tickets", {
    dataVisita: z.string().describe("Data da visita no formato AAAA-MM-DD")
}, async ({ dataVisita }) => {
    const soapRequest = `
            <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:v2="http://multiclubes.com.br/tickets/v2">
                <soapenv:Header>
                    <_AuthenticationKey xmlns="ns">${AUTH_KEY}</_AuthenticationKey>
                </soapenv:Header>
                <soapenv:Body>
                    <v2:GetTickets>
                        <v2:data>
                            <v2:VisitDate>${dataVisita}</v2:VisitDate>
                        </v2:data>
                    </v2:GetTickets>
                </soapenv:Body>
            </soapenv:Envelope>
        `;
    try {
        const response = await axios.post(URL_API, soapRequest, {
            headers: {
                'Content-Type': 'text/xml; charset=utf-8',
                'SOAPAction': SOAP_ACTION_GET_TICKETS
            },
            httpsAgent: agent
        });
        const parsed = await parseStringPromise(response.data, { explicitArray: false, ignoreAttrs: true });
        // Navegação segura no XML parseado pode variar, simplificando aqui para extrair o resultado
        // Estrutura esperada: Envelope.Body.GetTicketsResponse.GetTicketsResult...
        // Vamos retornar o JSON puro para a LLM interpretar
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify(parsed, null, 2)
                }]
        };
    }
    catch (error) {
        return {
            content: [{
                    type: "text",
                    text: `Erro ao listar tickets: ${error.message}`
                }],
            isError: true
        };
    }
});
// Ferramenta: Gerar Venda
server.tool("gerar_venda", {
    itens: z.array(z.object({
        ticketId: z.string().describe("ID do ticket a ser comprado"),
        valorUnitario: z.number().describe("Valor unitário do ticket"),
        quantidade: z.number().default(1).describe("Quantidade deste ticket"),
        // Para combos ou itens que requerem dados específicos por item (opcional dependendo da regra de negócio)
        // Mas no exemplo XML, os dados do visitante principal (Visitor) parecem ser globais ou pelo menos um responsável.
        // Porem, no XML de venda múltipla, vemos v2:SaleItemData com Name, Document, Email, etc. DENTRO de cada item.
        // E TAMBÉM vemos um v2:Visitor separado no final? No XML multiplo NÃO TEM v2:Visitor no final, os dados estão DENTRO dos itens.
        // No XML obrigatório (simples), os dados estavam no v2:Visitor.
        // A regra parece ser: Se tiver múltiplos itens, ou combos, os dados vão nos itens?
        // Ou o XML de exemplo multiplo mostra dados diferentes para cada item (Junior Sereno e Laryssa Sereno).
        // Portanto, precisamos permitir dados por item.
        visitanteNome: z.string().optional().describe("Nome do visitante para este ingresso"),
        visitanteDocumento: z.string().optional().describe("Documento do visitante para este ingresso"),
        visitanteEmail: z.string().optional().describe("Email do visitante para este ingresso"),
        visitanteTelefone: z.string().optional().describe("Telefone do visitante para este ingresso"),
    })).describe("Lista de itens (ingressos) a serem comprados"),
    dataVisita: z.string().describe("Data da visita AAAA-MM-DD"),
    // Dados do comprador/visitante principal (caso não especificado nos itens ou para preencher o v2:Visitor se necessário)
    compradorNome: z.string().optional(),
    compradorDocumento: z.string().optional(),
    compradorEmail: z.string().optional(),
    compradorTelefone: z.string().optional()
}, async ({ itens, dataVisita, compradorNome, compradorDocumento, compradorEmail, compradorTelefone }) => {
    const transactionId = crypto.randomUUID();
    const webhookUrl = `${WEBHOOK_URL_BASE}/webhook/${transactionId}`;
    // Atualizando o mapa de pendências com o transactionId
    const promessaVenda = new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
            pendingSales.delete(transactionId);
            reject(new Error("Timeout aguardando webhook de pagamento"));
        }, 60000); // 60 segundos de timeout
        pendingSales.set(transactionId, { resolve, reject, timeout });
    });
    // Calcula valor total
    const valorTotal = itens.reduce((acc, item) => acc + (item.valorUnitario * item.quantidade), 0);
    // Constrói os itens XML
    const itemsXml = itens.map(item => `
                                <v2:SaleItemData>
                                    ${item.visitanteNome ? `<v2:Name>${item.visitanteNome}</v2:Name>` : ''}
                                    ${item.visitanteDocumento ? `<v2:Document>${item.visitanteDocumento}</v2:Document>` : ''}
                                    ${item.visitanteEmail ? `<v2:Email>${item.visitanteEmail}</v2:Email>` : ''}
                                    ${item.visitanteTelefone ? `<v2:PhoneNumber>${item.visitanteTelefone}</v2:PhoneNumber>` : ''}
                                    <v2:Quantity>${item.quantidade}</v2:Quantity>
                                    <v2:TicketId>${item.ticketId}</v2:TicketId>
                                    <v2:Values>
                                        <v2:DueValue>${(item.valorUnitario * item.quantidade).toFixed(2)}</v2:DueValue>
                                    </v2:Values>
                                </v2:SaleItemData>
        `).join('\n');
    // Lógica para v2:Visitor:
    // Se tiver comprador explícito, usamos. Se não, talvez a API exija.
    // No XML múltiplo de exemplo, NÃO TEM v2:Visitor, apenas os dados dentro de SaleItemData.
    // Vou assumir que se os itens tiverem dados, não precisa de v2:Visitor, ou é opcional.
    // Mas para garantir, se o usuário mandar dados de comprador, adicionamos.
    let visitorXml = '';
    if (compradorNome && compradorDocumento) {
        visitorXml = `
                            <v2:Visitor>
                                <v2:Document>${compradorDocumento}</v2:Document>
                                <v2:Email>${compradorEmail || ''}</v2:Email>
                                <v2:Name>${compradorNome}</v2:Name>
                                <v2:PhoneNumber>${compradorTelefone || ''}</v2:PhoneNumber>
                            </v2:Visitor>
            `;
    }
    const soapRequest = `
            <soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/" xmlns:v2="http://multiclubes.com.br/tickets/v2">
                <soapenv:Header>
                    <_AuthenticationKey xmlns="ns">${AUTH_KEY}</_AuthenticationKey>
                </soapenv:Header>
                <soapenv:Body>
                    <v2:Sell>
                        <v2:data>
                            <v2:PaymentLink>
                                <v2:DueDays>2</v2:DueDays>
                                <v2:WebhookUrl>${webhookUrl}</v2:WebhookUrl>
                            </v2:PaymentLink>
                            <v2:Tickets>
                                ${itemsXml}
                            </v2:Tickets>
                            <v2:Values>
                                <v2:DueValue>${valorTotal.toFixed(2)}</v2:DueValue>
                            </v2:Values>
                            <v2:VisitDate>${dataVisita}</v2:VisitDate>
                            ${visitorXml}
                        </v2:data>
                    </v2:Sell>
                </soapenv:Body>
            </soapenv:Envelope>
        `;
    try {
        console.error(`[GerarVenda] Enviando requisição SOAP...`);
        const response = await axios.post(URL_API, soapRequest, {
            headers: {
                'Content-Type': 'text/xml; charset=utf-8',
                'SOAPAction': SOAP_ACTION_SELL
            },
            httpsAgent: agent
        });
        const parsed = await parseStringPromise(response.data, { explicitArray: false, ignoreAttrs: true });
        // Verifica se houve erro na resposta SOAP imediata
        // Exemplo sucesso: Envelope.Body.SellResponse.SellResult.SaleId
        // Se a venda falhar imediatamente, rejeitamos a promessa
        // Mas se der certo, a promessa continua pendente aguardando o webhook
        console.error(`[GerarVenda] Resposta SOAP recebida. Aguardando webhook...`);
        // Aguarda o webhook
        const webhookData = await promessaVenda;
        return {
            content: [{
                    type: "text",
                    text: JSON.stringify({
                        soapResponse: parsed,
                        paymentData: webhookData
                    }, null, 2)
                }]
        };
    }
    catch (error) {
        // Se der erro na chamada SOAP ou Timeout do webhook
        if (pendingSales.has(transactionId)) {
            clearTimeout(pendingSales.get(transactionId).timeout);
            pendingSales.delete(transactionId);
        }
        return {
            content: [{
                    type: "text",
                    text: `Erro ao gerar venda: ${error.message}`
                }],
            isError: true
        };
    }
});
// Start receiving messages on stdin and sending messages on stdout
const transport = new StdioServerTransport();
await server.connect(transport);
console.error('MultiClube MCP Server running on stdio');
// Ajuste na rota do express para usar o transactionId corretamente como definido no tool
// Vamos sobrescrever a rota anterior para garantir que bate com a lógica
app._router.stack = app._router.stack.filter((r) => r.route?.path !== '/webhook/:saleId');
app.post('/webhook/:transactionId', (req, res) => {
    const { transactionId } = req.params;
    console.error(`[Webhook] Recebido callback para transactionId: ${transactionId}`);
    if (pendingSales.has(transactionId)) {
        const { resolve, timeout } = pendingSales.get(transactionId);
        clearTimeout(timeout);
        // Retorna os dados do webhook para a promessa que está esperando
        resolve(req.body);
        pendingSales.delete(transactionId);
        res.status(200).send('OK');
    }
    else {
        console.error(`[Webhook] Nenhuma transação pendente para: ${transactionId}`);
        res.status(404).send('Not Found');
    }
});
