import { Product, SearchParams } from '../types/index.js';

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:123.0) Gecko/20100101 Firefox/123.0',
];

export function randomUserAgent(): string {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

// ─── Mock Product Catalogue ───────────────────────────────────────────────────

const AMAZON_PRODUCTS: Product[] = [
  {
    id: 'B0CHX3TB6N',
    platform: 'amazon',
    title: 'boAt Rockerz 450 Bluetooth On-Ear Headphones with 15H Battery',
    price: 1299,
    currency: 'INR',
    rating: 4.1,
    reviewCount: 85432,
    imageUrl: 'https://m.media-amazon.com/images/I/61bOPADIsAL._SL1500_.jpg',
    productUrl: 'https://www.amazon.in/dp/B0CHX3TB6N',
    specs: { Brand: 'boAt', Color: 'Black', 'Battery Life': '15 hrs', Connectivity: 'Bluetooth 5.0' },
  },
  {
    id: 'B0CXBY9J4T',
    platform: 'amazon',
    title: 'Sony WH-1000XM5 Wireless Noise Cancelling Headphones',
    price: 22990,
    currency: 'INR',
    rating: 4.5,
    reviewCount: 12840,
    imageUrl: 'https://m.media-amazon.com/images/I/61KJlhpBkpL._SL1500_.jpg',
    productUrl: 'https://www.amazon.in/dp/B0CXBY9J4T',
    specs: { Brand: 'Sony', 'Noise Cancellation': 'Yes', 'Battery Life': '30 hrs', Connectivity: 'Bluetooth 5.2' },
  },
  {
    id: 'B0BVXG2WX3',
    platform: 'amazon',
    title: 'Nike Revolution 6 Running Shoes for Men',
    price: 3695,
    currency: 'INR',
    rating: 4.3,
    reviewCount: 9210,
    imageUrl: 'https://m.media-amazon.com/images/I/71QmPxl2hkL._UY500_.jpg',
    productUrl: 'https://www.amazon.in/dp/B0BVXG2WX3',
    specs: { Brand: 'Nike', Material: 'Mesh', Sole: 'Rubber', 'Fit Type': 'Regular' },
  },
  {
    id: 'B08N5W4NMB',
    platform: 'amazon',
    title: 'OnePlus Nord CE 3 Lite 5G (8GB RAM, 128GB Storage)',
    price: 17999,
    currency: 'INR',
    rating: 4.2,
    reviewCount: 34560,
    imageUrl: 'https://m.media-amazon.com/images/I/71i7xY1FFDL._SL1500_.jpg',
    productUrl: 'https://www.amazon.in/dp/B08N5W4NMB',
    specs: { Brand: 'OnePlus', RAM: '8 GB', Storage: '128 GB', 'Battery': '5000 mAh' },
  },
  {
    id: 'B09X7BKB9D',
    platform: 'amazon',
    title: 'JBL Flip 6 Portable Bluetooth Speaker Waterproof',
    price: 8999,
    currency: 'INR',
    rating: 4.4,
    reviewCount: 21345,
    imageUrl: 'https://m.media-amazon.com/images/I/71GsB2aQa3L._SL1500_.jpg',
    productUrl: 'https://www.amazon.in/dp/B09X7BKB9D',
    specs: { Brand: 'JBL', 'Water Resistance': 'IP67', 'Battery Life': '12 hrs', Connectivity: 'Bluetooth 5.1' },
  },
  {
    id: 'B0BHZTKSQY',
    platform: 'amazon',
    title: 'Adidas Duramo SL Running Shoes Men',
    price: 2999,
    currency: 'INR',
    rating: 4.1,
    reviewCount: 6780,
    imageUrl: 'https://m.media-amazon.com/images/I/71MuoYRVxeL._UY500_.jpg',
    productUrl: 'https://www.amazon.in/dp/B0BHZTKSQY',
    specs: { Brand: 'Adidas', Material: 'Knit upper', Sole: 'Rubber', 'Closure': 'Lace-up' },
  },
  {
    id: 'B0B9V9GKDM',
    platform: 'amazon',
    title: 'Samsung Galaxy F34 5G (6GB RAM, 128GB)',
    price: 14999,
    currency: 'INR',
    rating: 4.2,
    reviewCount: 18920,
    imageUrl: 'https://m.media-amazon.com/images/I/71jbxFCHIfL._SL1500_.jpg',
    productUrl: 'https://www.amazon.in/dp/B0B9V9GKDM',
    specs: { Brand: 'Samsung', RAM: '6 GB', Storage: '128 GB', Battery: '6000 mAh' },
  },
  {
    id: 'B0CH3QJVH9',
    platform: 'amazon',
    title: 'HP 15s Laptop Intel Core i3, 8GB RAM, 512GB SSD',
    price: 39990,
    currency: 'INR',
    rating: 4.3,
    reviewCount: 5670,
    imageUrl: 'https://m.media-amazon.com/images/I/71W1O0xjqtL._SL1500_.jpg',
    productUrl: 'https://www.amazon.in/dp/B0CH3QJVH9',
    specs: { Brand: 'HP', Processor: 'Intel Core i3', RAM: '8 GB', Storage: '512 GB SSD' },
  },
];

const FLIPKART_PRODUCTS: Product[] = [
  {
    id: 'MOBGTAGPTHUZECP2',
    platform: 'flipkart',
    title: 'Realme Narzo N55 (Prime Black, 4GB RAM, 64GB Storage)',
    price: 10999,
    currency: 'INR',
    rating: 4.2,
    reviewCount: 28450,
    imageUrl: 'https://rukminim2.flixcart.com/image/416/416/xif0q/mobile/j/z/b/-original-imagtb3aghkzfhyg.jpeg',
    productUrl: 'https://www.flipkart.com/realme-narzo-n55/p/MOBGTAGPTHUZECP2',
    specs: { Brand: 'Realme', RAM: '4 GB', Storage: '64 GB', Battery: '5000 mAh', MRP: '₹12,999' },
  },
  {
    id: 'WATGPZHMHPYQGSGT',
    platform: 'flipkart',
    title: 'Fastrack Reflex Beat Smartwatch with 1.83" Display',
    price: 1995,
    currency: 'INR',
    rating: 3.9,
    reviewCount: 14230,
    imageUrl: 'https://rukminim2.flixcart.com/image/416/416/xif0q/smartwatch/q/z/h/-original-imaghzqgyytnhrky.jpeg',
    productUrl: 'https://www.flipkart.com/fastrack-reflex-beat/p/WATGPZHMHPYQGSGT',
    specs: { Brand: 'Fastrack', 'Display': '1.83 inch', 'Battery': '7 days', 'Water Resistance': 'IP68', MRP: '₹3,495' },
  },
  {
    id: 'SHOGTDHKH5FQXZPQ',
    platform: 'flipkart',
    title: 'Puma Softride Pro Running Shoes For Men',
    price: 2499,
    currency: 'INR',
    rating: 4.3,
    reviewCount: 8760,
    imageUrl: 'https://rukminim2.flixcart.com/image/416/416/xif0q/shoe/b/f/g/-original-imagtzygyqhgghbg.jpeg',
    productUrl: 'https://www.flipkart.com/puma-softride-pro/p/SHOGTDHKH5FQXZPQ',
    specs: { Brand: 'Puma', Material: 'Mesh', Sole: 'EVA', MRP: '₹4,499', Highlights: 'Lightweight, Breathable' },
  },
  {
    id: 'TVSGPZV3FHYMDQZM',
    platform: 'flipkart',
    title: 'MI 32 inch HD Ready Smart LED TV (2023)',
    price: 12499,
    currency: 'INR',
    rating: 4.3,
    reviewCount: 45320,
    imageUrl: 'https://rukminim2.flixcart.com/image/416/416/xif0q/television/q/8/a/-original-imagpge7nhz8qhre.jpeg',
    productUrl: 'https://www.flipkart.com/mi-80cm-32-inches-hd-ready-smart-led-tv/p/TVSGPZV3FHYMDQZM',
    specs: { Brand: 'MI', 'Screen Size': '32 inch', Resolution: 'HD Ready', 'Smart TV': 'Yes', MRP: '₹17,999' },
  },
  {
    id: 'TABGTAJVKFZFNHQZ',
    platform: 'flipkart',
    title: 'Lenovo IdeaPad Slim 3 Intel Core i5, 8GB RAM, 512GB SSD',
    price: 42990,
    currency: 'INR',
    rating: 4.4,
    reviewCount: 7890,
    imageUrl: 'https://rukminim2.flixcart.com/image/416/416/xif0q/computer/w/b/o/-original-imagpyygrghzhhqz.jpeg',
    productUrl: 'https://www.flipkart.com/lenovo-ideapad-slim-3/p/TABGTAJVKFZFNHQZ',
    specs: { Brand: 'Lenovo', Processor: 'Intel Core i5', RAM: '8 GB', Storage: '512 GB SSD', MRP: '₹52,990' },
  },
  {
    id: 'EARGTAB3ZMHQDMZP',
    platform: 'flipkart',
    title: 'boAt Airdopes 141 TWS Earbuds 42H Playtime',
    price: 999,
    currency: 'INR',
    rating: 4.1,
    reviewCount: 112340,
    imageUrl: 'https://rukminim2.flixcart.com/image/416/416/xif0q/headphone/w/3/w/-original-imaghdgfhzqmxqhf.jpeg',
    productUrl: 'https://www.flipkart.com/boat-airdopes-141/p/EARGTAB3ZMHQDMZP',
    specs: { Brand: 'boAt', 'Total Playtime': '42 hrs', 'Water Resistance': 'IPX4', MRP: '₹2,990', Connectivity: 'Bluetooth 5.3' },
  },
  {
    id: 'MOBGTAKUZHYFQMPZ',
    platform: 'flipkart',
    title: 'Motorola G84 5G (256GB, Viva Magenta)',
    price: 15999,
    currency: 'INR',
    rating: 4.3,
    reviewCount: 9870,
    imageUrl: 'https://rukminim2.flixcart.com/image/416/416/xif0q/mobile/4/b/h/-original-imagqhbzpyzfhfcv.jpeg',
    productUrl: 'https://www.flipkart.com/moto-g84-5g/p/MOBGTAKUZHYFQMPZ',
    specs: { Brand: 'Motorola', RAM: '12 GB', Storage: '256 GB', Battery: '5000 mAh', MRP: '₹19,999' },
  },
  {
    id: 'SHOGTAB4UMHQZPLT',
    platform: 'flipkart',
    title: 'Skechers Go Walk Flex Men Casual Shoes',
    price: 3199,
    currency: 'INR',
    rating: 4.4,
    reviewCount: 5620,
    imageUrl: 'https://rukminim2.flixcart.com/image/416/416/xif0q/shoe/m/y/p/-original-imagpyzghhfqzmpz.jpeg',
    productUrl: 'https://www.flipkart.com/skechers-go-walk-flex/p/SHOGTAB4UMHQZPLT',
    specs: { Brand: 'Skechers', Material: 'Mesh', Sole: 'Rubber', MRP: '₹5,499', Highlights: 'Memory Foam, Air-Cooled' },
  },
];

const MYNTRA_PRODUCTS: Product[] = [
  {
    id: '24228878',
    platform: 'myntra',
    title: 'Nike Men Revolution 6 Running Shoes',
    price: 3695,
    currency: 'INR',
    rating: 4.3,
    reviewCount: 4320,
    imageUrl: 'https://assets.myntassets.com/h_560,q_90,w_420/v1/assets/images/24228878/2023/8/21/abc.jpg',
    productUrl: 'https://www.myntra.com/sports-shoes/nike/nike-men-revolution-6-running-shoes/24228878/buy',
    specs: { Brand: 'Nike', Gender: 'Men', Category: 'Sports Shoes', MRP: '₹4,595' },
  },
  {
    id: '20457322',
    platform: 'myntra',
    title: "Levi's Men Slim Fit Stretchable Jeans",
    price: 1919,
    currency: 'INR',
    rating: 4.2,
    reviewCount: 8760,
    imageUrl: 'https://assets.myntassets.com/h_560,q_90,w_420/v1/assets/images/20457322/2022/abc.jpg',
    productUrl: 'https://www.myntra.com/jeans/levis/levis-men-slim-fit-stretchable-jeans/20457322/buy',
    specs: { Brand: "Levi's", Gender: 'Men', Category: 'Jeans', MRP: '₹3,999', Fit: 'Slim' },
  },
  {
    id: '25671234',
    platform: 'myntra',
    title: 'Puma Men Sneaker Running Shoes',
    price: 3149,
    currency: 'INR',
    rating: 4.4,
    reviewCount: 6540,
    imageUrl: 'https://assets.myntassets.com/h_560,q_90,w_420/v1/assets/images/25671234/2023/abc.jpg',
    productUrl: 'https://www.myntra.com/sports-shoes/puma/puma-men-sneaker/25671234/buy',
    specs: { Brand: 'Puma', Gender: 'Men', Category: 'Sports Shoes', MRP: '₹5,999' },
  },
  {
    id: '18934567',
    platform: 'myntra',
    title: 'H&M Women Oversized Cotton T-Shirt',
    price: 799,
    currency: 'INR',
    rating: 4.1,
    reviewCount: 12340,
    imageUrl: 'https://assets.myntassets.com/h_560,q_90,w_420/v1/assets/images/18934567/2023/abc.jpg',
    productUrl: 'https://www.myntra.com/tshirts/hm/hm-women-oversized-tshirt/18934567/buy',
    specs: { Brand: 'H&M', Gender: 'Women', Category: 'T-Shirts', MRP: '₹999', Material: 'Cotton' },
  },
  {
    id: '22345678',
    platform: 'myntra',
    title: 'Adidas Men Ultraboost Light Running Shoes',
    price: 14999,
    currency: 'INR',
    rating: 4.5,
    reviewCount: 3210,
    imageUrl: 'https://assets.myntassets.com/h_560,q_90,w_420/v1/assets/images/22345678/2023/abc.jpg',
    productUrl: 'https://www.myntra.com/sports-shoes/adidas/adidas-men-ultraboost/22345678/buy',
    specs: { Brand: 'Adidas', Gender: 'Men', Category: 'Sports Shoes', MRP: '₹19,999', Technology: 'Boost Cushioning' },
  },
  {
    id: '19876543',
    platform: 'myntra',
    title: 'Roadster Men Solid Hooded Sweatshirt',
    price: 629,
    currency: 'INR',
    rating: 4.0,
    reviewCount: 23450,
    imageUrl: 'https://assets.myntassets.com/h_560,q_90,w_420/v1/assets/images/19876543/2023/abc.jpg',
    productUrl: 'https://www.myntra.com/sweatshirts/roadster/roadster-men-sweatshirt/19876543/buy',
    specs: { Brand: 'Roadster', Gender: 'Men', Category: 'Sweatshirts', MRP: '₹1,299', Material: 'Cotton Blend' },
  },
  {
    id: '17654321',
    platform: 'myntra',
    title: 'ONLY Women Flared Fit Midi Dress',
    price: 1349,
    currency: 'INR',
    rating: 4.2,
    reviewCount: 7890,
    imageUrl: 'https://assets.myntassets.com/h_560,q_90,w_420/v1/assets/images/17654321/2023/abc.jpg',
    productUrl: 'https://www.myntra.com/dresses/only/only-women-midi-dress/17654321/buy',
    specs: { Brand: 'ONLY', Gender: 'Women', Category: 'Dresses', MRP: '₹2,299', Length: 'Midi' },
  },
  {
    id: '21098765',
    platform: 'myntra',
    title: 'U.S. Polo Assn. Men Slim Fit Casual Shirt',
    price: 1079,
    currency: 'INR',
    rating: 4.3,
    reviewCount: 9870,
    imageUrl: 'https://assets.myntassets.com/h_560,q_90,w_420/v1/assets/images/21098765/2023/abc.jpg',
    productUrl: 'https://www.myntra.com/shirts/us-polo-assn/us-polo-assn-men-shirt/21098765/buy',
    specs: { Brand: 'U.S. Polo Assn.', Gender: 'Men', Category: 'Shirts', MRP: '₹1,999', Fit: 'Slim' },
  },
];

const ALL_PRODUCTS: Record<string, Product[]> = {
  amazon: AMAZON_PRODUCTS,
  flipkart: FLIPKART_PRODUCTS,
  myntra: MYNTRA_PRODUCTS,
};

// ─── Exported helpers ─────────────────────────────────────────────────────────

export function getMockProducts(
  platform: string,
  query: string,
  params: Partial<SearchParams>
): Product[] {
  const catalogue = ALL_PRODUCTS[platform] ?? [];
  const keywords = query.toLowerCase().split(/\s+/);

  let results = catalogue.filter((p) => {
    const searchable = `${p.title} ${p.specs['Brand'] ?? ''} ${p.specs['Category'] ?? ''}`.toLowerCase();
    return keywords.some((kw) => searchable.includes(kw));
  });

  // If no keyword match, return all (generic fallback)
  if (results.length === 0) results = catalogue;

  if (params.minPrice !== undefined) results = results.filter((p) => p.price >= params.minPrice!);
  if (params.maxPrice !== undefined) results = results.filter((p) => p.price <= params.maxPrice!);

  return results.sort((a, b) => b.rating - a.rating).slice(0, 5);
}

export function getMockProduct(platform: string, id: string): Product | null {
  return ALL_PRODUCTS[platform]?.find((p) => p.id === id) ?? null;
}
