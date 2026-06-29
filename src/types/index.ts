export type Platform = 'amazon' | 'flipkart' | 'myntra' | 'meesho' | 'nykaa' | 'ajio';

export interface Product {
  id: string;
  platform: Platform;
  title: string;
  price: number;
  currency: string;
  rating: number;
  reviewCount: number;
  imageUrl: string;
  productUrl: string;
  specs: Record<string, string>;
}

export interface SearchParams {
  query: string;
  minPrice?: number;
  maxPrice?: number;
  category?: string;
  platforms?: Platform[];
}

export interface SearchResult {
  platform: Platform;
  products: Product[];
  error?: string;
}

export interface ComparisonResult {
  products: Product[];
  comparisonTable: ComparisonRow[];
}

export interface ComparisonRow {
  attribute: string;
  values: Record<string, string>;
}

export interface BuyIntent {
  product: Product;
  checkoutUrl: string;
  stage: 'awaiting_address' | 'awaiting_phone' | 'confirmed';
  address?: string;
}

export interface UserSession {
  userId: string;
  messages: ConversationMessage[];
  lastActivity: Date;
  searchResults?: Product[];
  buyIntent?: BuyIntent;
  wishlist?: Product[];
  preferredLanguage?: 'en' | 'hi';
}

export interface ConversationMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface WhatsAppMessage {
  from: string;
  text: string;
  messageId: string;
}

export interface ToolResult {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
}
