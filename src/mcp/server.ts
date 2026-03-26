import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import dotenv from 'dotenv';

import { searchProducts } from './tools/searchProducts.js';
import { compareProducts } from './tools/compareProducts.js';
import { getProductDetails } from './tools/getProductDetails.js';
import { getBuyLink } from './tools/getBuyLink.js';

dotenv.config();

const server = new Server(
  { name: 'shopping-aggregator', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'search_products',
      description:
        'Search for products across Amazon, Flipkart, and Myntra. Returns top results from each platform sorted by rating.',
      inputSchema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'Product search query (e.g., "running shoes", "iPhone 15")',
          },
          minPrice: {
            type: 'number',
            description: 'Minimum price in INR (optional)',
          },
          maxPrice: {
            type: 'number',
            description: 'Maximum price in INR (optional)',
          },
          category: {
            type: 'string',
            description: 'Product category (optional)',
          },
          platforms: {
            type: 'array',
            items: { type: 'string', enum: ['amazon', 'flipkart', 'myntra'] },
            description: 'Platforms to search (default: all three)',
          },
        },
        required: ['query'],
      },
    },
    {
      name: 'compare_products',
      description:
        'Compare selected products side-by-side showing price, rating, and key specifications.',
      inputSchema: {
        type: 'object',
        properties: {
          products: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                productId: { type: 'string', description: 'Product ID' },
                platform: {
                  type: 'string',
                  enum: ['amazon', 'flipkart', 'myntra'],
                  description: 'Platform the product is from',
                },
              },
              required: ['productId', 'platform'],
            },
            description: 'List of products to compare (max 6)',
            maxItems: 6,
          },
        },
        required: ['products'],
      },
    },
    {
      name: 'get_product_details',
      description: 'Get detailed information about a specific product.',
      inputSchema: {
        type: 'object',
        properties: {
          productId: { type: 'string', description: 'Product ID' },
          platform: {
            type: 'string',
            enum: ['amazon', 'flipkart', 'myntra'],
            description: 'Platform the product is from',
          },
        },
        required: ['productId', 'platform'],
      },
    },
    {
      name: 'get_buy_link',
      description: 'Get the direct purchase URL for a product.',
      inputSchema: {
        type: 'object',
        properties: {
          productId: { type: 'string', description: 'Product ID' },
          platform: {
            type: 'string',
            enum: ['amazon', 'flipkart', 'myntra'],
            description: 'Platform the product is from',
          },
        },
        required: ['productId', 'platform'],
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args = {} } = request.params;

  try {
    switch (name) {
      case 'search_products': {
        const result = await searchProducts({
          query: args['query'] as string,
          minPrice: args['minPrice'] as number | undefined,
          maxPrice: args['maxPrice'] as number | undefined,
          category: args['category'] as string | undefined,
          platforms: args['platforms'] as ('amazon' | 'flipkart' | 'myntra')[] | undefined,
        });
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'compare_products': {
        const productsArg = args['products'] as Array<{
          productId: string;
          platform: string;
        }>;
        const result = await compareProducts(productsArg);
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'get_product_details': {
        const result = await getProductDetails(
          args['productId'] as string,
          args['platform'] as string
        );
        if (!result) {
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: 'Product not found' }) }],
            isError: true,
          };
        }
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      case 'get_buy_link': {
        const result = await getBuyLink(
          args['productId'] as string,
          args['platform'] as string
        );
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      }

      default:
        return {
          content: [{ type: 'text', text: `Unknown tool: ${name}` }],
          isError: true,
        };
    }
  } catch (err) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            error: err instanceof Error ? err.message : 'Tool execution failed',
          }),
        },
      ],
      isError: true,
    };
  }
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('[MCP] Shopping aggregator server running on stdio');
}

main().catch((err) => {
  console.error('[MCP] Fatal error:', err);
  process.exit(1);
});
