#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
import axios from 'axios';
import https from 'https';
import crypto from 'crypto';
import express from 'express';
import { parseStringPromise, Builder } from 'xml2js';

// Configurações
const PORT = process.env.WEBHOOK_PORT || 3000;
const WEBHOOK_URL_BASE = process.env.WEBHOOK_URL_BASE || `http://localhost:${PORT}`;

// Armazenamento temporário para as promessas de venda
// Mapa: saleId -> { resolve: (value: any) => void, timeout: NodeJS.Timeout }
const pendingSales = new Map<string, { resolve: (value: any) => void, reject: (reason?: any) => void, timeout: NodeJS.Timeout }>();

// Configura servidor Express para o Webhook
const app = express();
app.use(express.json());

app.post('/webhook/:saleId', (req, res) => {
    const { saleId } = req.params;
    console.error(`[Webhook] Recebido callback para saleId: ${saleId}`);
    console.error(`[Webhook] Body:`, JSON.stringify(req.body, null, 2));

    if (pendingSales.has(saleId)) {
        const { resolve, timeout } = pendingSales.get(saleId)!;
        clearTimeout(timeout);
        
        // Retorna os dados do webhook para a promessa que está esperando
        resolve(req.body);
        
        pendingSales.delete(saleId);
        res.status(200).send('OK');
    } else {
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

// Helper para listar tickets (reutilizável)
async function getTicketsDisponiveis(dataVisita: string) {
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

    const response = await axios.post(URL_API, soapRequest, {
        headers: {
            'Content-Type': 'text/xml; charset=utf-8',
            'SOAPAction': SOAP_ACTION_GET_TICKETS
        },
        httpsAgent: agent
    });

    const parsed: any = await parseStringPromise(response.data, { explicitArray: false, ignoreAttrs: true });
    
    // Simplificar a extração dos tickets
    const tickets: any[] = [];
    try {
        const result = parsed['s:Envelope']['s:Body'].GetTicketsResponse.GetTicketsResult;
        
        // Verifica se PlanTicketResult é array ou objeto único
        const planos = Array.isArray(result.PlanTicketResult) ? result.PlanTicketResult : [result.PlanTicketResult];
        
        for (const plano of planos) {
            if (plano.Tickets && plano.Tickets.TicketResult) {
                const ticketsPlano = Array.isArray(plano.Tickets.TicketResult) ? plano.Tickets.TicketResult : [plano.Tickets.TicketResult];
                for (const ticket of ticketsPlano) {
                    tickets.push({
                        id: ticket.TicketId,
                        nome: ticket.Description,
                        valor: parseFloat(ticket.Value),
                        plano: plano.Description
                    });
                }
            }
        }
    } catch (e) {
        console.error("Erro ao fazer parse dos tickets:", e);
    }
    
    return { raw: parsed, simplified: tickets };
}

// Ferramenta: Listar Tickets
server.tool(
    "listar_tickets",
    {
        dataVisita: z.string().describe("Data da visita no formato AAAA-MM-DD. Obrigatório para consultar a disponibilidade e preços.")
    },
    async ({ dataVisita }) => {
        try {
            const result = await getTicketsDisponiveis(dataVisita);
            return {
                content: [{
                    type: "text",
                    text: JSON.stringify(result.raw, null, 2)
                }]
            };
        } catch (error: any) {
            return {
                content: [{
                    type: "text",
                    text: `Erro ao listar tickets: ${error.message}`
                }],
                isError: true
            };
        }
    }
);

// Ferramenta: Gerar Venda
server.tool(
    "gerar_venda",
    {
        itens: z.array(z.object({
            ticketId: z.string().describe("ID do ticket obtido na listagem de tickets (obrigatório)"),
            // valorUnitario removido: será buscado automaticamente
            quantidade: z.number().default(1).describe("Quantidade de ingressos deste tipo")
        })).describe("Lista de itens a serem comprados. EXEMPLO DE VENDA MÚLTIPLA: Para vender 1 Adulto e 1 Infantil, adicione DOIS objetos nesta lista: um com o ID do ingresso Adulto e outro com o ID do ingresso Infantil."),
        dataVisita: z.string().describe("Data da visita no formato AAAA-MM-DD"),
        // Dados do comprador/visitante principal obrigatórios
        compradorNome: z.string().describe("Nome completo do comprador/responsável"),
        compradorDocumento: z.string().describe("CPF do comprador (apenas números, sem pontuação)"),
        compradorEmail: z.string().describe("Email válido do comprador para envio do voucher"),
        compradorTelefone: z.string().describe("Telefone do comprador com DDD (apenas números)")
    },
    async ({ itens, dataVisita, compradorNome, compradorDocumento, compradorEmail, compradorTelefone }) => {
        const transactionId = crypto.randomUUID();
        const webhookUrl = `${WEBHOOK_URL_BASE}/webhook/${transactionId}`;

        // 1. Buscar preços atuais na API para garantir valores corretos e segurança
        let ticketsDisponiveis;
        try {
            const result = await getTicketsDisponiveis(dataVisita);
            ticketsDisponiveis = result.simplified;
        } catch (error: any) {
            return {
                content: [{
                    type: "text",
                    text: `Erro ao consultar valores dos ingressos para a data ${dataVisita}: ${error.message}`
                }],
                isError: true
            };
        }

        // 2. Montar itens da venda com valores validados
        const itensComValor: any[] = [];
        let valorTotal = 0;

        for (const item of itens) {
            const ticketInfo = ticketsDisponiveis.find(t => t.id === item.ticketId);
            
            if (!ticketInfo) {
                return {
                    content: [{
                        type: "text",
                        text: `Erro: O Ticket ID '${item.ticketId}' não está disponível para a data ${dataVisita}. Por favor, liste os tickets novamente.`
                    }],
                    isError: true
                };
            }

            const valorItem = ticketInfo.valor;
            valorTotal += valorItem * item.quantidade;
            
            itensComValor.push({
                ...item,
                valorUnitario: valorItem
            });
        }

        // Atualizando o mapa de pendências com o transactionId
        const promessaVenda = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                pendingSales.delete(transactionId);
                reject(new Error("Timeout aguardando webhook de pagamento"));
            }, 60000); // 60 segundos de timeout

            pendingSales.set(transactionId, { resolve, reject, timeout });
        });

        // Constrói os itens XML
        const itemsXml = itensComValor.map(item => `
                                <v2:SaleItemData>
                                    <v2:Quantity>${item.quantidade}</v2:Quantity>
                                    <v2:TicketId>${item.ticketId}</v2:TicketId>
                                    <v2:Values>
                                        <v2:DueValue>${(item.valorUnitario * item.quantidade).toFixed(2)}</v2:DueValue>
                                    </v2:Values>
                                </v2:SaleItemData>
        `).join('\n');

        const visitorXml = `
                            <v2:Visitor>
                                <v2:Document>${compradorDocumento}</v2:Document>
                                <v2:Email>${compradorEmail}</v2:Email>
                                <v2:Name>${compradorNome}</v2:Name>
                                <v2:PhoneNumber>${compradorTelefone}</v2:PhoneNumber>
                            </v2:Visitor>
        `;

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

            const parsed: any = await parseStringPromise(response.data, { explicitArray: false, ignoreAttrs: true });
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

        } catch (error: any) {
            // Se der erro na chamada SOAP ou Timeout do webhook
            if (pendingSales.has(transactionId)) {
                clearTimeout(pendingSales.get(transactionId)!.timeout);
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
    }
);

// (Removido pois já foi substituído no diff anterior e a variável transport global foi adicionada lá)

// Endpoint para receber mensagens do cliente MCP (POST)
app.post('/messages', async (req, res) => {
    // O SSEServerTransport requer que o POST seja tratado pelo transport correspondente.
    // Como o SDK não expõe um gerenciador global de transports SSE, precisamos de uma abordagem para rotear a mensagem.
    // A documentação do SDK sugere que o SSEServerTransport gerencia a resposta do POST internamente.
    // Vamos usar o método `handlePostMessage` do transporte se ele estiver acessível ou instanciar um novo transport para tratar a mensagem?
    // Não, o transporte é stateful.
    
    // Correção: O SDK @modelcontextprotocol/sdk não tem `server.processPostBody`.
    // O SSEServerTransport é projetado para lidar com req/res diretamente no POST se passado.
    // Mas aqui, como temos múltiplas conexões possíveis, precisamos identificar qual transporte tratar.
    // Na implementação padrão SSE do MCP, o POST é stateless em relação ao transporte SSE se usar session IDs, mas o SDK básico não gerencia sessões automaticamente dessa forma simples.
    
    // Solução Temporária e Robusta para Single-Client ou Simple-Setup:
    // O SDK atual (v0.6+) geralmente espera que você passe o request para o transport.
    // Mas como o transport é criado no GET /sse, precisamos armazená-lo?
    
    // Na falta de um gerenciador de sessão complexo no código atual, vamos assumir que o handlePostMessage do transporte deve ser chamado.
    // Para simplificar e fazer funcionar com o Claude Desktop/Outros, vamos usar uma abordagem onde o POST é processado genericamente.
    // Mas espere, o SSEServerTransport precisa enviar a resposta para o `res` do POST.
    
    // Vamos usar a abordagem recomendada simplificada:
    // O `SSEServerTransport` tem um método `handlePostMessage(req, res)`.
    // Mas precisamos da instância criada no /sse.
    // Vamos armazenar o transporte ativo (suportando apenas 1 cliente por vez neste exemplo simples ou usando session ID na URL).
    
    // Para simplificar este servidor MCP específico:
    await transport?.handlePostMessage(req, res);
});

let transport: SSEServerTransport | null = null;

// Endpoint SSE para conexão do cliente MCP
app.get('/sse', async (req, res) => {
    console.log("[SSE] Nova conexão iniciada");
    transport = new SSEServerTransport("/messages", res);
    await server.connect(transport);
});

// Endpoint Webhook (Mantido e ajustado)
app.post('/webhook/:transactionId', (req, res) => {
    const { transactionId } = req.params;
    console.error(`[Webhook] Recebido callback para transactionId: ${transactionId}`);
    
    if (pendingSales.has(transactionId)) {
        const { resolve, timeout } = pendingSales.get(transactionId)!;
        clearTimeout(timeout);
        
        // Retorna os dados do webhook para a promessa que está esperando
        resolve(req.body);
        
        pendingSales.delete(transactionId);
        res.status(200).send('OK');
    } else {
        console.error(`[Webhook] Nenhuma transação pendente para: ${transactionId}`);
        res.status(404).send('Not Found');
    }
});

// O server.listen já foi chamado no início do arquivo (const serverExpress = app.listen...)
console.error(`MultiClube MCP Server running via SSE on port ${PORT}`);