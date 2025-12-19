# MultiClube MCP Server

Este projeto implementa um servidor MCP para integração com a API MultiClube, focado na venda de ingressos (Day Use).

## Estado Atual (2025-12-19)

### Listagem de Tickets (Testado em 20/12/2025)

A API retornou os seguintes ingressos disponíveis para a data solicitada:

**Planos Disponíveis:**

1.  **COMBO O VERÃO COMEÇA AQUI (ID: 822516)**
    *   **Ticket:** COMBO O VERÃO COMEÇA AQUI (ID: 823851) - R$ 205.00

2.  **COMBOS 1 DIA (ID: 822510)**
    *   **Ticket:** COMBO 03 INGRESSOS (ID: 823826) - R$ 300.00
    *   **Ticket:** COMBO 04 INGRESSOS (ID: 823827) - R$ 380.00
    *   **Ticket:** COMBO 05 INGRESSOS (ID: 823828) - R$ 460.00

3.  **INGRESSOS 1 DIA (ID: 822504)**
    *   **Ticket:** INGRESSO ADULTO I A partir de 12 anos (ID: 823813) - R$ 105.00
    *   **Ticket:** INGRESSO INFANTIL I 06 a 11 anos (ID: 823814) - R$ 62.00

### Estrutura do XML de Retorno (Exemplo)

```xml
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <GetTicketsResponse xmlns="http://multiclubes.com.br/tickets/v2">
      <GetTicketsResult xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
        <PlanTicketResult>
          <Description>COMBO O VERÃO COMEÇA AQUI</Description>
          <PlanId>822516</PlanId>
          <Tickets>
            <TicketResult>
              <Available>-1</Available> <!-- Disponibilidade ilimitada/não controlada por cota rígida? -->
              <Description>COMBO O VERÃO COMEÇA AQUI</Description>
              <Reserve i:nil="true"/>
              <TicketId>823851</TicketId>
              <Value>205.00</Value>
            </TicketResult>
          </Tickets>
        </PlanTicketResult>
        <!-- Outros Planos... -->
      </GetTicketsResult>
    </GetTicketsResponse>
  </s:Body>
</s:Envelope>
```

### Funcionalidades do MCP

*   **listar_tickets:** Retorna a lista de tickets disponíveis para uma data.
*   **gerar_venda:** Gera um link de pagamento para a compra de ingressos.
    *   **Ajuste Recente:** A estrutura de venda foi simplificada para exigir dados do comprador (Visitor) apenas uma vez por venda, e não por ingresso, alinhando com o comportamento padrão observado nos exemplos.
    *   **Campos Obrigatórios do Comprador:** Nome, Documento (CPF), Email e Telefone.

### Venda (Testado em 21/12/2025 - Data simulada no payload)

A API processou a venda com sucesso (ID: 166118) e retornou os códigos de acesso dos ingressos.

**Exemplo de Retorno (XML):**
```xml
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/">
  <s:Body>
    <SellResponse xmlns="http://multiclubes.com.br/tickets/v2">
      <SellResult xmlns:i="http://www.w3.org/2001/XMLSchema-instance">
        <SaleId>166118</SaleId>
        <Tickets>
          <SaleItemResult>
            <AccessCode>80251211</AccessCode>
            <Document i:nil="true"/>
            <Interval i:nil="true"/>
            <Name i:nil="true"/>
            <TicketId>823851</TicketId>
          </SaleItemResult>
          <!-- ... outros itens ... -->
        </Tickets>
      </SellResult>
    </SellResponse>
  </s:Body>
</s:Envelope>
```

### Webhook de Pagamento (Recebido após a venda na URL do webhook)

O sistema recebe um callback (Webhook) contendo o link de pagamento. Este link é o que deve ser enviado para o cliente.

**Exemplo de Payload Recebido da API:**

```json
{
  "eventType": "Created",
  "data": {
    "saleId": 166118,
    "dueDate": "21/12/2025",
    "voucherCode": "IFWH166118",
    "orderNumber": "2497220251219122719",
    "url": "https://loja.multiclubes.com.br/balipark/pagamento/Ylo2NUpYWjlSR0kyb1B0ckVGR1k2dz09",
    "value": 325.00
  }
}
```