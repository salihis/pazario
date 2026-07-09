-- AddForeignKey
ALTER TABLE "price_calculations" ADD CONSTRAINT "price_calculations_productId_fkey" FOREIGN KEY ("productId") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "price_calculations" ADD CONSTRAINT "price_calculations_syncJobId_fkey" FOREIGN KEY ("syncJobId") REFERENCES "sync_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
