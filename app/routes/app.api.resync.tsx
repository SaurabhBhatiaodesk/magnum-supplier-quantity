import type { ActionFunctionArgs } from "@remix-run/node";
import { json } from "@remix-run/node";
import { authenticate } from "../shopify.server";
import prisma from "../db.server";
import { M_SET_ON_HAND, M_INVENTORY_ACTIVATE, Q_SHOP_LOCATIONS } from "../utils/graphql.server";

// Helper function to update inventory quantity
async function updateInventoryQuantity(
  admin: any,
  productId: string,
  inventoryQuantity: number | string | undefined
) {
  try {
    if (inventoryQuantity === undefined || inventoryQuantity === null || inventoryQuantity === '') {
      return;
    }

    const qty = typeof inventoryQuantity === 'string' 
      ? parseFloat(inventoryQuantity.replace(/[^0-9.\-]/g, '')) 
      : Number(inventoryQuantity);
    
    if (isNaN(qty)) {
      return;
    }

    const quantity = Math.max(0, Math.floor(qty));

    // Get all shop locations
    const locationsResp = await admin.graphql(Q_SHOP_LOCATIONS, { variables: { first: 250 } });
    const locationsResult = await locationsResp.json();
    const locations = locationsResult?.data?.shop?.locations?.edges || [];
    
    if (locations.length === 0) {
      return;
    }

    const locationIds = locations.map((edge: any) => edge.node.id);

    // Get product variants with inventory item IDs
    const getProductQuery = `#graphql
      query getProduct($productId: ID!) {
        product(id: $productId) {
          id
          variants(first: 10) {
            edges {
              node {
                id
                inventoryItem {
                  id
                }
              }
            }
          }
        }
      }
    `;

    const productResp = await admin.graphql(getProductQuery, {
      variables: { productId }
    });
    const productResult = await productResp.json();
    const variants = productResult?.data?.product?.variants?.edges || [];

    if (variants.length === 0) {
      return;
    }

    // Activate inventory items at all locations first
    const activatedLocations = new Set<string>();
    
    for (const variantEdge of variants) {
      const variant = variantEdge.node;
      const inventoryItemId = variant.inventoryItem?.id;
      
      if (!inventoryItemId) continue;

      for (const locationId of locationIds) {
        try {
          const activateResp = await admin.graphql(M_INVENTORY_ACTIVATE, {
            variables: { inventoryItemId, locationId }
          });
          const activateResult = await activateResp.json();
          
          if (activateResult?.data?.inventoryActivate?.userErrors?.length > 0) {
            const errorMsg = activateResult.data.inventoryActivate.userErrors[0]?.message;
            if (errorMsg.includes('already') || errorMsg.includes('activated') || errorMsg.includes('already active')) {
              activatedLocations.add(locationId);
            }
          } else if (activateResult?.data?.inventoryActivate?.inventoryLevel) {
            activatedLocations.add(locationId);
          }
        } catch (activateErr: any) {
          // Ignore activation errors
        }
      }
    }
    
    const validLocationIds = locationIds.filter((locId: string) => activatedLocations.has(locId));
    if (validLocationIds.length === 0) {
      return;
    }

    // Prepare inventory updates
    const inventoryUpdates: { inventoryItemId: string; locationId: string; quantity: number }[] = [];
    
    for (const variantEdge of variants) {
      const variant = variantEdge.node;
      const inventoryItemId = variant.inventoryItem?.id;
      
      if (!inventoryItemId) continue;

      for (const locationId of validLocationIds) {
        inventoryUpdates.push({
          inventoryItemId,
          locationId,
          quantity
        });
      }
    }

    if (inventoryUpdates.length === 0) {
      return;
    }

    // Batch update inventory
    const BATCH_SIZE = 200;
    for (let i = 0; i < inventoryUpdates.length; i += BATCH_SIZE) {
      const batch = inventoryUpdates.slice(i, i + BATCH_SIZE);
      
      try {
        await admin.graphql(M_SET_ON_HAND, {
          variables: {
            input: {
              reason: "correction",
              setQuantities: batch
            }
          }
        });
      } catch (err: any) {
        console.error("❌ Error setting inventory batch:", err);
      }
    }
  } catch (error) {
    console.error('❌ Error in updateInventoryQuantity:', error);
  }
}

// Helper function to update Shopify product
async function updateShopifyProduct(admin: any, productId: string, productData: any) {
  try {
    // Update the product
    const productMutation = `#graphql
      mutation productUpdate($input: ProductInput!) {
        productUpdate(input: $input) {
          product { 
            id 
            title 
            handle
            status
          }
          userErrors { field message }
        }
      }
    `;

    const productInput = {
      id: productId,
      title: productData.title || productData.name || 'Unknown Product',
      descriptionHtml: productData.descriptionHtml || productData.description || '',
      vendor: productData.vendor || '',
      productType: productData.productType || '',
      tags: productData.tags || [],
      status: productData.status || 'ACTIVE'
    };

    const productResponse = await admin.graphql(productMutation, { variables: { input: productInput } });
    const productResult = await productResponse.json();
    
    if (productResult.data?.productUpdate?.userErrors?.length > 0) {
      throw new Error(productResult.data.productUpdate.userErrors[0].message);
    }

    const product = productResult.data?.productUpdate?.product;
    if (!product) {
      throw new Error('Failed to update product');
    }

    // Update variants
    const getVariantsQuery = `#graphql
      query getProductVariants($productId: ID!) {
        product(id: $productId) {
          variants(first: 10) {
            edges {
              node {
                id
                sku
                price
                inventoryItem {
                  id
                }
              }
            }
          }
        }
      }
    `;

    const variantsResponse = await admin.graphql(getVariantsQuery, {
      variables: { productId: product.id }
    });
    const variantsResult = await variantsResponse.json();
    const existingVariants = variantsResult.data?.product?.variants?.edges || [];

    if (existingVariants.length > 0) {
      const existingVariant = existingVariants[0]?.node;

      if (existingVariant) {
        const bulkUpdateVariantsMutation = `#graphql
          mutation productVariantsBulkUpdate($productId: ID!, $variants: [ProductVariantsBulkInput!]!) {
            productVariantsBulkUpdate(productId: $productId, variants: $variants) {
              product { id }
              productVariants { 
                id 
                sku 
                price 
                barcode
              }
              userErrors { field message }
            }
          }
        `;

        const toMoneyString = (val: any): string | undefined => {
          if (val === null || val === undefined) return undefined;
          const cleaned = String(val).trim();
          if (cleaned === '') return undefined;
          const num = parseFloat(cleaned.replace(/[^0-9.\-]/g, ''));
          if (Number.isNaN(num)) return undefined;
          return num.toFixed(2);
        };

        const variantInput: any = {
          id: existingVariant.id
        };

        const priceStr = toMoneyString(productData.price);
        if (priceStr !== undefined) {
          variantInput.price = priceStr;
        }

        const skuValue = productData.variants?.[0]?.sku || productData.sku || productData.code || '';
        if (skuValue && String(skuValue).trim() !== '') {
          variantInput.inventoryItem = {
            sku: String(skuValue).trim()
          };
        }

        if (productData.barcode) {
          variantInput.barcode = String(productData.barcode);
        }

        await admin.graphql(bulkUpdateVariantsMutation, {
          variables: { 
            productId: product.id,
            variants: [variantInput]
          }
        });

        // Update inventory quantity if mapped
        const inventoryQty = productData.variants?.[0]?.inventoryQuantity;
        if (inventoryQty !== undefined && inventoryQty !== null && inventoryQty !== '') {
          await updateInventoryQuantity(admin, product.id, inventoryQty);
        }
      }
    }

    return product;
  } catch (error) {
    console.error(`❌ Error updating Shopify product:`, error);
    throw error;
  }
}

// Helper function to parse API updated_at timestamp
function parseApiTimestamp(updatedAt: string | null | undefined): Date | null {
  if (!updatedAt) return null;
  try {
    return new Date(updatedAt);
  } catch {
    return null;
  }
}

// Helper function to fetch API data
async function fetchApiData(apiUrl: string, accessToken: string) {
  try {
    const normalizedToken = accessToken.replace(/^Bearer\s+/i, "");
    
    // Fetch ALL pages with pagination to get all products for resync
    let allItems: any[] = [];
    let nextPageUrl: string | null = apiUrl;
    let pageCount = 0;
    const maxPages = 1000; // Safety limit
    
    console.log('🔄 Starting pagination fetch for resync from:', nextPageUrl);
    
    while (nextPageUrl && pageCount < maxPages) {
      pageCount++;
      console.log(`📄 Resync: Fetching page ${pageCount}: ${nextPageUrl}`);
      
      const res: Response = await fetch(nextPageUrl, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${normalizedToken}`,
          Accept: "application/json",
          "User-Agent": "Shopify-Product-Import/1.0"
        },
        signal: AbortSignal.timeout(30000) // 30 second timeout per page
      });
      
      console.log(`Resync API Response Status (Page ${pageCount}):`, res.status);
      
      if (!res.ok) {
        console.error(`Resync API fetch failed for page ${pageCount}:`, res.status, res.statusText);
        break;
      }
      
      const body: any = await res.json();
      
      // Extract items from API response
      let pageItems: any[] = [];
      if (Array.isArray(body)) {
        pageItems = body;
        console.log(`Resync Page ${pageCount}: Found array with ${pageItems.length} items`);
      } else if (body && typeof body === 'object') {
        // Check for common API response structures
        if (Array.isArray(body.data)) {
          pageItems = body.data;
          console.log(`Resync Page ${pageCount}: Found data array with ${pageItems.length} items`);
        } else if (Array.isArray(body.products)) {
          pageItems = body.products;
          console.log(`Resync Page ${pageCount}: Found products array with ${pageItems.length} items`);
        } else {
          // Search for any array in the response
          for (const key of Object.keys(body)) {
            const val = (body as any)[key];
            if (Array.isArray(val) && val.length > 0 && typeof val[0] === 'object') {
              pageItems = val;
              console.log(`Resync Page ${pageCount}: Found array in key "${key}" with ${pageItems.length} items`);
              break;
            }
          }
        }
      }
      
      if (pageItems.length > 0) {
        allItems = allItems.concat(pageItems);
        console.log(`Resync Page ${pageCount}: Collected ${pageItems.length} items, Total so far: ${allItems.length}`);
      }
      
      // Get next page URL
      nextPageUrl = body.next_page_url || null;
      if (nextPageUrl) {
        console.log(`Resync Page ${pageCount}: Next page URL found: ${nextPageUrl}`);
      } else {
        console.log(`Resync Page ${pageCount}: No next page URL, pagination complete`);
        break;
      }
    }
    
    console.log(`✅ Resync pagination complete - Fetched ${pageCount} page(s), Total items: ${allItems.length}`);
    
    return allItems;
  } catch (error) {
    console.error('Resync API fetch error:', error);
    throw error;
  }
}

export const action = async ({ request }: ActionFunctionArgs) => {
  try {
    const { admin, session } = await authenticate.admin(request);
    
    if (!session?.shop) {
      return json({ success: false, error: "Unauthorized" }, { status: 401 });
    }

    const body = await request.json();
    const { connectionId } = body;

    if (!connectionId) {
      return json({ success: false, error: "Connection ID is required" }, { status: 400 });
    }

    // Get connection
    const connection = await prisma.connection.findFirst({
      where: {
        id: connectionId,
        shop: session.shop
      }
    });

    if (!connection) {
      return json({ success: false, error: "Connection not found" }, { status: 404 });
    }

    if (connection.type !== 'api' || !connection.apiUrl || !connection.accessToken) {
      return json({ success: false, error: "Invalid connection type or missing credentials" }, { status: 400 });
    }

    console.log(`🔄 Starting smart resync for connection: ${connection.name}`);

    // Return immediately - processing will continue in background
    // This prevents Cloudflare 524 timeout for large resyncs
    console.log('📤 Returning early - resync will continue in background...');
    
    const earlyResponse = json({
      success: true,
      message: "Resync started, processing in background...",
      stats: {
        total: 0,
        updated: 0,
        created: 0,
        skipped: 0,
        errors: 0
      }
    });

    // Continue processing in background (don't await)
    (async () => {
      try {
        console.log('🔄 Starting background resync processing...');
        
        // Fetch all products from API
        if (!connection.apiUrl || !connection.accessToken) {
          console.error('❌ Missing API credentials for resync');
          return;
        }
        const apiProducts = await fetchApiData(connection.apiUrl, connection.accessToken);
        console.log(`📦 Fetched ${apiProducts.length} products from API`);

        // Get all existing products for this connection
        const existingProducts = await prisma.importedProduct.findMany({
          where: {
            shop: session.shop,
            connectionId: connection.id
          }
        });

        console.log(`💾 Found ${existingProducts.length} existing products in database`);

        // Create a map of existing products by shopifyProductId (GraphQL ID) for quick lookup
        const existingProductsMapByGraphQLId = new Map<string, typeof existingProducts[0]>();
        // Map by SKU and code both for matching
        const existingProductsMapBySku = new Map<string, typeof existingProducts[0]>();
        const existingProductsMapByCode = new Map<string, typeof existingProducts[0]>();
        
        for (const product of existingProducts) {
          // Map by GraphQL ID (primary)
          if (product.shopifyProductId) {
            existingProductsMapByGraphQLId.set(product.shopifyProductId, product);
          }
          // Map by SKU
          if (product.sku) {
            existingProductsMapBySku.set(product.sku, product);
          }
          // Map by code (if different from SKU) - using title as fallback for code
          // Note: We'll match by SKU first, then by code from API
          const codeKey = product.sku || product.title; // Use SKU as code key if available
          if (codeKey) {
            existingProductsMapByCode.set(codeKey, product);
          }
        }

        let updated = 0;
        let created = 0;
        let skipped = 0;
        const errors: string[] = [];

        // Process each product from API
        for (const apiProduct of apiProducts) {
          try {
            // Get both code and SKU from API
            const apiCode = apiProduct.code || '';
            const apiSku = apiProduct.sku || '';
            const apiUpdatedAt = parseApiTimestamp(apiProduct.updated_at);
            
            if (!apiCode && !apiSku) {
              console.log(`⚠️ Skipping product without code/SKU: ${apiProduct.title || 'Unknown'}`);
              skipped++;
              continue;
            }

            // Step 1: Find existing product by SKU first, then by code
            let existingProduct = null;
            if (apiSku) {
              existingProduct = existingProductsMapBySku.get(apiSku);
              if (existingProduct) {
                console.log(`🔍 Found product by SKU: ${apiSku}`);
              }
            }
            
            // If not found by SKU, try by code
            if (!existingProduct && apiCode) {
              existingProduct = existingProductsMapByCode.get(apiCode);
              if (existingProduct) {
                console.log(`🔍 Found product by code: ${apiCode}`);
              }
            }

            if (existingProduct) {
              // Product exists in database - check if it needs update using updated_at
              const existingApiUpdatedAt = (existingProduct as any).apiUpdatedAt;
          
              // IMPORTANT: Check updated_at timestamp
              if (apiUpdatedAt && existingApiUpdatedAt) {
                // Compare timestamps - only update if API's updated_at is newer
                if (apiUpdatedAt <= existingApiUpdatedAt) {
                  console.log(`⏩ Skipping - no changes detected (API updated_at: ${apiUpdatedAt.toISOString()}, DB apiUpdatedAt: ${existingApiUpdatedAt.toISOString()})`);
                  skipped++;
                  continue;
                }
                console.log(`✅ Update needed - API updated_at (${apiUpdatedAt.toISOString()}) is newer than DB (${existingApiUpdatedAt.toISOString()})`);
              } else if (!apiUpdatedAt) {
                console.log(`⚠️ API product missing updated_at, skipping update check`);
                skipped++;
                continue;
              } else if (!existingApiUpdatedAt) {
                console.log(`⚠️ Database product missing apiUpdatedAt, will update`);
              }

              // Product needs update based on updated_at check
              const productIdentifier = apiSku || apiCode;
              console.log(`🔄 Updating product: ${productIdentifier} (API updated_at: ${apiUpdatedAt?.toISOString() || 'N/A'})`);

              // Step 2: Get GraphQL ID from database and verify in Shopify
              if (existingProduct.shopifyProductId) {
                const graphQLId = existingProduct.shopifyProductId;
                console.log(`🔍 Using GraphQL ID from database: ${graphQLId}`);
                
                // Step 3: Verify product exists in Shopify using GraphQL ID
                try {
                  const verifyProductQuery = `#graphql
                    query getProductById($id: ID!) {
                      product(id: $id) {
                        id
                        title
                        status
                        variants(first: 1) {
                          edges {
                            node {
                              id
                              sku
                            }
                          }
                        }
                      }
                    }
                  `;
                  
                  const verifyResp = await admin.graphql(verifyProductQuery, {
                    variables: { id: graphQLId }
                  });
                  const verifyResult = await verifyResp.json();
                  
                  if (!verifyResult.data?.product) {
                    console.log(`⚠️ Product not found in Shopify with GraphQL ID: ${graphQLId}, will create new`);
                    // Product doesn't exist in Shopify, create it
                    // TODO: Add product creation logic here
                    skipped++;
                    continue;
                  }
                  
                  console.log(`✅ Product verified in Shopify: ${verifyResult.data.product.title} (ID: ${graphQLId})`);
                  
                  // Step 4: Update in Shopify using GraphQL ID
                  // Transform API product to Shopify format
                  // Handle on_hand value - convert string to number
                  const onHandValue = apiProduct.on_hand;
                  let inventoryQty = 0;
                  if (onHandValue !== undefined && onHandValue !== null && onHandValue !== '') {
                    const parsed = parseFloat(String(onHandValue).replace(/[^0-9.\-]/g, ''));
                    if (!isNaN(parsed)) {
                      inventoryQty = Math.max(0, Math.floor(parsed));
                    }
                  }
                  
                  const shopifyProductData = {
                    title: apiProduct.title || apiProduct.name || 'Unknown Product',
                    descriptionHtml: apiProduct.description || '',
                    vendor: apiProduct.vendor || '',
                    productType: apiProduct.productType || '',
                    tags: apiProduct.tags || [],
                    status: 'ACTIVE',
                    price: apiProduct.price || '0.00',
                    sku: apiSku || apiCode,
                    barcode: apiProduct.barcode || apiProduct.quantities?.[0]?.gtin || '',
                    variants: [{
                      price: apiProduct.price || '0.00',
                      sku: apiSku || apiCode,
                      barcode: apiProduct.barcode || apiProduct.quantities?.[0]?.gtin || '',
                      inventoryQuantity: inventoryQty
                    }]
                  };

                  // Update using GraphQL ID from database
                  await updateShopifyProduct(admin, graphQLId, shopifyProductData);

                  // Update in database
                  await prisma.importedProduct.update({
                    where: { id: existingProduct.id },
                    data: {
                      title: shopifyProductData.title,
                      bodyHtml: shopifyProductData.descriptionHtml,
                      vendor: shopifyProductData.vendor,
                      productType: shopifyProductData.productType,
                      price: shopifyProductData.price,
                      sku: apiSku || apiCode,
                      inventoryQuantity: shopifyProductData.variants[0].inventoryQuantity,
                      apiUpdatedAt: apiUpdatedAt,
                      updatedAt: new Date()
                    } as any
                  });

                  updated++;
                  console.log(`✅ Updated product: ${apiSku || apiCode}`);
                } catch (verifyError: any) {
                  console.error(`❌ Error verifying/updating product ${apiSku || apiCode}:`, verifyError);
                  errors.push(`Failed to verify/update ${apiSku || apiCode}: ${verifyError.message}`);
                }
              } else {
                // Product exists in DB but not in Shopify - create it
                console.log(`🆕 Creating Shopify product for existing DB product: ${apiSku || apiCode}`);
                // TODO: Implement product creation logic if needed
                skipped++;
              }
            } else {
              // New product - create it
              console.log(`🆕 Creating new product: ${apiSku || apiCode}`);
              
              // TODO: Implement product creation logic
              // For now, we'll skip new products in resync (they should be created in full import)
              skipped++;
            }
          } catch (error: any) {
            console.error(`❌ Error processing product:`, error);
            errors.push(`Error processing product: ${error.message}`);
            skipped++;
          }
        }

        // Update connection last sync time
        await prisma.connection.update({
          where: { id: connection.id },
          data: { 
            lastSync: new Date(),
            updatedAt: new Date()
          }
        });

        console.log(`✅ Background resync completed: ${updated} updated, ${created} created, ${skipped} skipped`);
      } catch (backgroundError: any) {
        console.error('❌ Background resync processing error:', backgroundError);
      }
    })(); // Execute async function without awaiting - continues in background

    // Return early response immediately
    return earlyResponse;

  } catch (error: any) {
    console.error('❌ Resync error:', error);
    return json({ 
      success: false, 
      error: error.message || "Failed to resync products" 
    }, { status: 500 });
  }
};
