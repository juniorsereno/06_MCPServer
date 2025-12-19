#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import axios from 'axios';
import https from 'https';
import crypto from 'crypto';
import express, { Request, Response } from 'express';
import { parseStringPromise } from 'xml2js';

// Configurações
const PORT = process.env.WEBHOOK_PORT || 3000;
const WEBHOOK_URL_BASE = process.env.WEBHOOK_URL_BASE || `http://localhost:${PORT}`;

// Armazenamento temporário para as promessas de venda
const pendingSales = new Map<string, { resolve: (value: any) => void, reject: (reason?: any) => void, timeout: NodeJS.Timeout }>();

// Configura servidor Express
const app = express();

// Middleware de JSON apenas para rotas específicas (não para /mcp)
app.use('/webhook', express.json());
app.use('/health', express.json());

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
    
    const tickets: any[] = [];
    try {
        const result = parsed['s:Envelope']['s:Body'].GetTicketsResponse.GetTicketsResult;
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

// Helper para obter data atual no formato AAAA-MM-DD (timezone Brasil)
function getDataAtualBrasil(): string {
    const now = new Date();
    // Ajusta para timezone de Brasília (UTC-3)
    const brasilOffset = -3 * 60;
    const localOffset = now.getTimezoneOffset();
    const brasilTime = new Date(now.getTime() + (localOffset - brasilOffset) * 60000);
    return brasilTime.toISOString().split('T')[0];
}

// Helper para validar se a data não é passada
function validarDataFutura(dataVisita: string): { valida: boolean; mensagem?: string } {
    const hoje = getDataAtualBrasil();
    if (dataVisita < hoje) {
        return {
            valida: false,
            mensagem: `ERRO: A data informada (${dataVisita}) é uma data PASSADA. Hoje é ${hoje}. Por favor, informe uma data igual ou posterior a hoje.`
        };
    }
    return { valida: true };
}

// Ferramenta: Listar Tickets
server.tool(
    "listar_tickets",
    {
        dataVisita: z.string().describe(`Data da visita no formato AAAA-MM-DD. IMPORTANTE: A data atual é ${getDataAtualBrasil()}. Não aceite datas passadas. Para "amanhã", calcule a data correta a partir de hoje. Obrigatório para consultar a disponibilidade e preços dos ingressos.`)
    },
    async ({ dataVisita }) => {
        // Validação de data passada ANTES de chamar a API
        const validacao = validarDataFutura(dataVisita);
        if (!validacao.valida) {
            return {
                content: [{
                    type: "text",
                    text: validacao.mensagem!
                }],
                isError: true
            };
        }

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
        dataVisita: z.string().describe(`Data da visita no formato AAAA-MM-DD. IMPORTANTE: A data atual é ${getDataAtualBrasil()}. Não aceite datas passadas.`),
        // Dados do comprador/visitante principal obrigatórios
        compradorNome: z.string().describe("Nome completo do comprador/responsável"),
        compradorDocumento: z.string().describe("CPF do comprador (apenas números, sem pontuação)"),
        compradorEmail: z.string().describe("Email válido do comprador para envio do voucher"),
        compradorTelefone: z.string().describe("Telefone do comprador com DDD (apenas números)")
    },
    async ({ itens, dataVisita, compradorNome, compradorDocumento, compradorEmail, compradorTelefone }) => {
        // Validação de data passada ANTES de processar
        const validacao = validarDataFutura(dataVisita);
        if (!validacao.valida) {
            return {
                content: [{
                    type: "text",
                    text: validacao.mensagem!
                }],
                isError: true
            };
        }

        const transactionId = crypto.randomUUID();
        const webhookUrl = `${WEBHOOK_URL_BASE}/webhook/${transactionId}`;

        // 1. Buscar preços atuais na API
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
            const ticketInfo = ticketsDisponiveis.find((t: any) => t.id === item.ticketId);
            
            if (!ticketInfo) {
                return {
                    content: [{
                        type: "text",
                        text: `Erro: O Ticket ID '${item.ticketId}' não está disponível para a data ${dataVisita}.`
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

        // Promessa para aguardar webhook
        const promessaVenda = new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                pendingSales.delete(transactionId);
                reject(new Error("Timeout aguardando webhook de pagamento"));
            }, 60000);

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
            console.error(`[GerarVenda] Resposta SOAP recebida. Aguardando webhook...`);

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


// Armazena sessões de transporte ativas (para stateful sessions)
const transports = new Map<string, StreamableHTTPServerTransport>();

// Endpoint MCP - HTTP Streamable (único endpoint para todas as operações)
app.all('/mcp', async (req: Request, res: Response) => {
    console.log(`[MCP] ${req.method} request received`);
    
    // Obtém ou cria session ID
    const sessionId = req.headers['mcp-session-id'] as string | undefined;
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports.has(sessionId)) {
        // Reutiliza transporte existente
        transport = transports.get(sessionId)!;
        console.log(`[MCP] Reusing session: ${sessionId}`);
    } else if (req.method === 'POST' || req.method === 'GET') {
        // Cria novo transporte para nova sessão
        transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: () => crypto.randomUUID(),
            onsessioninitialized: (newSessionId) => {
                console.log(`[MCP] New session initialized: ${newSessionId}`);
                transports.set(newSessionId, transport);
            }
        });

        // Conecta o servidor MCP ao transporte
        await server.connect(transport);

        // Limpa sessão quando fechada
        transport.onclose = () => {
            const sid = Array.from(transports.entries()).find(([_, t]) => t === transport)?.[0];
            if (sid) {
                console.log(`[MCP] Session closed: ${sid}`);
                transports.delete(sid);
            }
        };
    } else {
        // Método não suportado sem sessão
        res.status(400).json({ error: 'Bad Request: No valid session' });
        return;
    }

    // Delega o handling para o transporte
    try {
        await transport.handleRequest(req, res);
    } catch (error: any) {
        console.error(`[MCP] Error handling request:`, error);
        if (!res.headersSent) {
            res.status(500).json({ error: error.message });
        }
    }
});

// Endpoint DELETE para encerrar sessão
app.delete('/mcp', async (req: Request, res: Response) => {
    const sessionId = req.headers['mcp-session-id'] as string;
    
    if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        await transport.close();
        transports.delete(sessionId);
        console.log(`[MCP] Session terminated: ${sessionId}`);
        res.status(200).json({ message: 'Session terminated' });
    } else {
        res.status(404).json({ error: 'Session not found' });
    }
});

// Webhook endpoint para receber callbacks de pagamento
app.post('/webhook/:transactionId', (req: Request, res: Response) => {
    const { transactionId } = req.params;
    console.error(`[Webhook] Recebido callback para transactionId: ${transactionId}`);
    console.error(`[Webhook] Body:`, JSON.stringify(req.body, null, 2));
    
    if (pendingSales.has(transactionId)) {
        const { resolve, timeout } = pendingSales.get(transactionId)!;
        clearTimeout(timeout);
        resolve(req.body);
        pendingSales.delete(transactionId);
        res.status(200).send('OK');
    } else {
        console.error(`[Webhook] Nenhuma transação pendente para: ${transactionId}`);
        res.status(404).send('Not Found');
    }
});

// Health check
app.get('/health', (_req: Request, res: Response) => {
    res.status(200).json({ status: 'ok', transport: 'streamable-http' });
});

// Inicia o servidor
app.listen(PORT, () => {
    console.log(`MultiClube MCP Server running on port ${PORT}`);
    console.log(`MCP endpoint: http://localhost:${PORT}/mcp`);
    console.log(`Health check: http://localhost:${PORT}/health`);
});
