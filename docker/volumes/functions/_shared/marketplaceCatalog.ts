export interface MarketplaceProduct {
  id: number;
  name: string;
  description: string;
  price: number;
  originalPrice: number | null;
  rating: number;
  reviews: number;
  category: string;
  image: string;
  cashback: number;
  inStock: boolean;
}

export interface MarketplaceCartInputItem {
  productId: number;
  quantity: number;
}

export interface MarketplaceCartLineItem {
  product: MarketplaceProduct;
  quantity: number;
  unitPriceCents: number;
  subtotalCents: number;
}

export const marketplaceProducts: MarketplaceProduct[] = [
  {
    id: 1,
    name: 'Kit Germinação Ouro',
    description: 'Kit completo com 200 sementes de Ipê (cinco espécies); três bandejas germinadoras; um fertilizante; um fungicida.',
    price: 149.9,
    originalPrice: null,
    rating: 4.95,
    reviews: 23,
    category: 'Kit',
    image: 'https://painel.maisfloresta.cloud/storage/v1/object/public/marketplace/kit%20ouro_SB.jpg',
    cashback: 10,
    inStock: true,
  },
  {
    id: 2,
    name: 'Kit Germinação Prata',
    description: 'Kit completo com 100 sementes de Ipê (cinco espécies); uma bandeja germinadora; um fertilizante; um fungicida.',
    price: 99.9,
    originalPrice: null,
    rating: 4.8,
    reviews: 35,
    category: 'Kit',
    image: 'https://painel.maisfloresta.cloud/storage/v1/object/public/marketplace/prata.jpg',
    cashback: 10,
    inStock: true,
  },
   {
    id: 3,
    name: 'Kit Germinação Prata',
    description: 'Kit completo com 100 sementes de Ipê (cinco espécies); uma bandeja germinadora; um fertilizante; um fungicida.',
    price: 1.00,
    originalPrice: null,
    rating: 4.8,
    reviews: 35,
    category: 'Kit',
    image: 'https://painel.maisfloresta.cloud/storage/v1/object/public/marketplace/prata.jpg',
    cashback: 10,
    inStock: true,
  },
];

export const marketplaceCategories = ['Todos', ...new Set(marketplaceProducts.map((product) => product.category))];

export const marketplaceProductMap = new Map(
  marketplaceProducts.map((product) => [product.id, product] as const),
);

export const toCents = (value: number) => Math.round(value * 100);

export const buildMarketplaceCartSignature = (items: MarketplaceCartInputItem[]) =>
  [...items]
    .sort((a, b) => a.productId - b.productId)
    .map((item) => `${item.productId}:${item.quantity}`)
    .join('|');

export function calculateMarketplaceCart(items: MarketplaceCartInputItem[]) {
  const normalizedItems = items.filter((item) => item.quantity > 0);

  if (normalizedItems.length === 0) {
    throw new Error('Seu carrinho está vazio.');
  }

  const lineItems: MarketplaceCartLineItem[] = normalizedItems.map((item) => {
    const product = marketplaceProductMap.get(item.productId);

    if (!product) {
      throw new Error(`Produto inválido: ${item.productId}.`);
    }

    if (!product.inStock) {
      throw new Error(`${product.name} está indisponível no momento.`);
    }

    if (!Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 20) {
      throw new Error(`Quantidade inválida para ${product.name}.`);
    }

    const unitPriceCents = toCents(product.price);

    return {
      product,
      quantity: item.quantity,
      unitPriceCents,
      subtotalCents: unitPriceCents * item.quantity,
    };
  });

  const totalCents = lineItems.reduce((sum, item) => sum + item.subtotalCents, 0);
  const itemCount = lineItems.reduce((sum, item) => sum + item.quantity, 0);

  return {
    lineItems,
    itemCount,
    totalCents,
    totalAmount: totalCents / 100,
  };
}
