/*
  Warnings:

  - You are about to drop the column `userId` on the `Job` table. All the data in the column will be lost.
  - You are about to drop the `User` table. If the table is not empty, all the data it contains will be lost.

  Login simplified to the DocGen pattern (ADO org URL + PAT identity only,
  see docs/architecture.md "App auth" / CR4 of the corrected work plan):
  there is no app-level session/RBAC to key a User row against anymore, so
  the User table and Job.userId are dropped rather than kept unused.

*/
-- DropForeignKey
ALTER TABLE "Job" DROP CONSTRAINT "Job_userId_fkey";

-- AlterTable
ALTER TABLE "Job" DROP COLUMN "userId";

-- DropTable
DROP TABLE "User";
