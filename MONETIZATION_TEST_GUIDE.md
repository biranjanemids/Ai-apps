# Monetization Features - Test Guide

This guide walks you through testing all four monetization features implemented.

## Prerequisites
- Development environment running: `npm run dev`
- WhatsApp webhook configured and receiving messages
- `.env` file updated with:
  ```
  AMAZON_AFFILIATE_TAG=test-tag-123
  ADMIN_PHONE_NUMBER=919876543210  (your WhatsApp number)
  ```

---

## Feature 1: Affiliate Link Tracking & UTM Parameters

### Test Steps

1. **Start the bot and search for a product**
   ```
   User: "Find me a phone"
   ```

2. **Tap "Buy Now" on any product**
   - The checkout URL should include:
     - Your affiliate tag (if configured): `tag=test-tag-123`
     - UTM parameters: `utm_source=whatsapp_bot&utm_medium=product_card&utm_campaign=amazon`

3. **Verify in the bot logs**
   ```
   [Webhook] Interactive from +91XXXXXXXXXX: buy__1__B123456__amazon
   ```

4. **Check the URL structure**
   - Open Developer Tools → Network tab
   - Look for the checkout URL in the message
   - Verify it contains your affiliate ID and UTM params

### Expected Output
```
✅ Checkout URL includes affiliate tag
✅ UTM parameters correctly formatted
✅ Click recorded in analytics
```

---

## Feature 2: Click Analytics & Conversion Tracking

### Test Steps

1. **User: Search and tap Buy Now multiple times**
   ```
   User: "Show me headphones"
   → Tap Buy Now on 2 products
   
   User: "Find me shoes"
   → Tap Buy Now on 1 product from different platform
   ```

2. **User: Type "stats" to view personal stats**
   ```
   User: "stats"
   
   Bot response:
   📊 Your Shopping Stats
   
     Amazon: 2 clicks
     Flipkart: 1 click
   
   💡 Total: 3 purchases initiated
   🎁 Exclusive offers on next purchase!
   ```

3. **Admin: Type "metrics" to view global metrics**
   ```
   Admin: "metrics"
   
   Bot response:
   📈 Affiliate Metrics
   
   👥 Total Users: 5
   🔗 Total Clicks: 15
   📊 Avg Clicks/User: 3.00
   
   Clicks by Platform:
     Amazon: 8
     Flipkart: 5
     Myntra: 2
   ```

4. **Verify in logs**
   ```
   [Analytics] Click recorded for user +91XXXXXXXXXX: platform=amazon, product=B123456
   [Analytics] Price drop detected for B123456 on amazon
   ```

### Expected Output
✅ Stats command shows accurate platform breakdown
✅ Metrics command works only for admin
✅ Click counts match number of Buy Now taps
✅ All platforms tracked correctly

---

## Feature 3: Price Drop Notifications

### Test Steps

1. **User: Add a product to wishlist**
   ```
   User: "Find me a watch"
   → Tap ❤️ Save button on any product
   
   Bot: ❤️ Saved to wishlist!
   ```

2. **Verify price is tracked**
   - Product price recorded in analytics
   - Check server logs:
   ```
   [Analytics] Price recorded: productId=B123456, platform=amazon, price=5999
   ```

3. **Simulate a price drop (for testing)**
   - Modify `priceHistory` in sessionManager to add an older price
   - Call `checkPriceDrop()` with new lower price
   - Price drop alert should trigger

4. **User receives notification**
   ```
   🔥 Price Drop Alert!
   
   🛒 Apple Watch SE
   
   📉 12% off - Save ₹2,400
   
   Was: ₹20,000
   Now: ₹17,600
   
   ⏱️ Limited time offer — act fast!
   Available on Amazon
   ```

5. **Cooldown period tested**
   - Alert should not repeat within 24 hours
   - Check server logs for alert throttling

### Expected Output
✅ Price history stored when product viewed
✅ Drop alerts sent when price falls 10%+
✅ Alert message formatted correctly with savings
✅ 24-hour cooldown prevents spam
✅ Only wishlist products tracked

---

## Feature 4: Platform-Specific CTAs & Value Propositions

### Test Steps

1. **Search for a product across platforms**
   ```
   User: "Find me a dress"
   ```

2. **Verify product cards include benefits**
   ```
   1. Red Party Dress
   💰 ₹2,999 · ⭐4.5
   🔥 20% off MRP
   ✨ Fast Prime delivery available    ← CTA benefit
   
   [💳 Buy Now] [❤️ Save] [📊 Compare]
   ```

3. **Check different platforms have different CTAs**
   - Amazon card: "Fast Prime delivery available"
   - Flipkart card: "Easy returns & exchanges"
   - Myntra card: "Fashion specials & styling"
   - Zepto card: "10-minute delivery"

4. **Verify CTA in search results footer**
   - After results listed, bot sends:
   ```
   💡 Tap "Buy Now" to support this service & unlock exclusive deals!
   ```

5. **Check message formatter logs**
   ```
   [Formatter] Added platform benefit: amazon → Prime delivery
   ```

### Expected Output
✅ Each product card includes platform benefit
✅ Benefits match platform strengths
✅ Global CTA appears in search results
✅ CTAs encourage purchase actions
✅ No broken emoji rendering

---

## Integration Testing

### Test Complete User Journey

1. **Search → View → Buy**
   ```
   User: "Find me a laptop under 50000"
   → See search results with platform benefits
   → Tap Buy Now
   → Click tracked in analytics
   → Price recorded
   ```

2. **Save → Wait → Notify**
   ```
   User: Tap ❤️ Save on 3 products
   → User: "stats" → Shows 3 saves
   → (System waits 6 hours for price check)
   → User receives price drop alert
   ```

3. **Admin Oversight**
   ```
   Admin: "metrics"
   → See platform-by-platform conversion data
   → Monitor affiliate performance
   → Optimize CTA based on data
   ```

---

## Performance Checklist

- [ ] No lag when recording clicks
- [ ] Stats command responds < 1 second
- [ ] Metrics command responds < 1 second
- [ ] Price tracking doesn't affect search performance
- [ ] Notifications sent within 2 minutes of price drop
- [ ] Memory usage stays under 100MB (in-memory analytics)
- [ ] No duplicate alerts sent to users

---

## Production Readiness Checklist

Before deploying to production:

- [ ] Affiliate IDs configured in .env
- [ ] ADMIN_PHONE_NUMBER set
- [ ] Database designed for price history (in-memory won't scale)
- [ ] Alert cooldown tested (24 hours)
- [ ] Admin commands restricted to admin phone
- [ ] UTM parameters tested with actual affiliate platforms
- [ ] Error handling for failed notifications
- [ ] Logs reviewed for sensitive data
- [ ] Rate limiting configured (don't spam users)
- [ ] Backup strategy for analytics data

---

## Troubleshooting

### Stats command shows 0 clicks
- Check webhook logs: is `recordBuyClick()` being called?
- Verify button IDs include `buy__` or `select__` prefix
- Check user is tapping Buy Now, not just viewing

### Metrics command not working
- Verify admin phone number is correct in .env
- Admin must be exact match (with country code)
- Check logs for `[Webhook] Admin metrics request from...`

### Price drop alerts not firing
- Verify prices are being recorded: check `recordProductPrice()` calls
- Ensure at least 2 price samples exist for the product
- Check price drop threshold (default 10%)
- Verify 24-hour cooldown hasn't blocked alert

### Affiliate links not working
- Test affiliate tag format with affiliate platform
- Verify UTM params don't break the URL
- Check affiliate platform accepts those parameters
- Test with mock data first (USE_MOCK_DATA=true)

### Slow response times
- Check how many users in memory (priceHistory Map could grow large)
- Consider pagination for metrics command
- Monitor Node.js heap usage

---

## Next Steps

After testing:

1. **Deploy to production**
   - Deploy to AWS/Vercel/Railway
   - Enable affiliate tracking
   - Configure real affiliate IDs

2. **Monitor performance**
   - Set up analytics dashboard
   - Track conversion rates by platform
   - Monitor click-to-purchase ratio

3. **Optimize CTAs**
   - A/B test different benefit messages
   - Analyze which CTAs get highest CTR
   - Customize by user segment

4. **Expand monetization**
   - Add premium tiers
   - Implement bulk order discounts
   - Add sponsored product listings

---

**Test Duration:** ~15 minutes for full feature walkthrough
**Complexity:** Medium (requires WhatsApp setup + mock data understanding)
