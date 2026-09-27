module.exports = {
  apps: [
    {
      name: "telegram-bot",
      script: "./artifacts/api-server/dist/index.mjs",
      env: {
        NODE_ENV: "production",
        PORT: "3000",
        TELEGRAM_BOT_TOKEN: "8904754161:AAFDRiyC32QB8pSPy9yDCw7suKp1onEjE-Q",
        TELEGRAM_API_ID: "33037872",
        TELEGRAM_API_HASH: "ae767202558f9d19db4fe3d2b9270db5",
        ADMIN_USER_IDS: "6103619762",
        TELEGRAM_SESSION_STRING: "1BVtsOLMBu00Zmgm9L-jk0Vj0UFv5ah0HJCMPRR1ABEWJe5C9tCxTpY3oP8w4JybbJiczHMGMryqIToHuK7OQAR93VuTcLb8zBlzPPzAvd91Mj8JBHy3EluVYXIPDHdaTNhADOIN4iL_QnZ8ULjGzeLDQPn1H1gOzsqmnMPpwPvrGVU61p4mnJR_LNEO3qnAcjq8agkdgWbcAmSxXM2d9CMNn5NctaWylxoM4I3DQbVNEU6tLE-xKpT-BuNYaTi0VKAzxmV_ZJbFXuCsWwLmGN8jpT97WE9YlAH57iq1k4KqxbGARMTykVYgZcChpHdVZaQfIwqFygsqC_mJ9uCVYJxhmZ08EWms=",
        DATABASE_URL: "postgresql://neondb_owner:npg_zTUk6rBjnY0M@ep-odd-darkness-b3d4ni23-pooler.c-4.ap-southeast-1.aws.neon.tech/neondb?sslmode=require&channel_binding=require"
      }
    }
  ]
};