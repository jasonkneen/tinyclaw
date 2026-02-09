#!/bin/bash
# TinyClaw Setup Wizard

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SETTINGS_FILE="$SCRIPT_DIR/.tinyclaw/settings.json"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BLUE='\033[0;34m'
NC='\033[0m'

mkdir -p "$SCRIPT_DIR/.tinyclaw"

echo ""
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo -e "${GREEN}  TinyClaw - Setup Wizard${NC}"
echo -e "${BLUE}━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━${NC}"
echo ""

# Channel selection
echo "Which messaging channels do you want to use?"
echo ""
echo "  1) Discord"
echo "  2) WhatsApp"
echo "  3) Telegram"
echo "  4) Discord + WhatsApp"
echo "  5) Discord + Telegram"
echo "  6) WhatsApp + Telegram"
echo "  7) All (Discord + WhatsApp + Telegram)"
echo ""
read -rp "Choose [1-7]: " CHANNEL_CHOICE

case "$CHANNEL_CHOICE" in
    1) CHANNEL="discord" ;;
    2) CHANNEL="whatsapp" ;;
    3) CHANNEL="telegram" ;;
    4) CHANNEL="discord+whatsapp" ;;
    5) CHANNEL="discord+telegram" ;;
    6) CHANNEL="whatsapp+telegram" ;;
    7) CHANNEL="all" ;;
    *)
        echo -e "${RED}Invalid choice${NC}"
        exit 1
        ;;
esac
echo -e "${GREEN}✓ Channel: $CHANNEL${NC}"
echo ""

# Discord bot token (if needed)
DISCORD_TOKEN=""
if [[ "$CHANNEL" == *"discord"* ]] || [[ "$CHANNEL" == "all" ]]; then
    echo "Enter your Discord bot token:"
    echo -e "${YELLOW}(Get one at: https://discord.com/developers/applications)${NC}"
    echo ""
    read -rp "Token: " DISCORD_TOKEN

    if [ -z "$DISCORD_TOKEN" ]; then
        echo -e "${RED}Discord bot token is required${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓ Discord token saved${NC}"
    echo ""
fi

# Telegram bot token (if needed)
TELEGRAM_TOKEN=""
if [[ "$CHANNEL" == *"telegram"* ]] || [[ "$CHANNEL" == "all" ]]; then
    echo "Enter your Telegram bot token:"
    echo -e "${YELLOW}(Create a bot via @BotFather on Telegram to get a token)${NC}"
    echo ""
    read -rp "Token: " TELEGRAM_TOKEN

    if [ -z "$TELEGRAM_TOKEN" ]; then
        echo -e "${RED}Telegram bot token is required${NC}"
        exit 1
    fi
    echo -e "${GREEN}✓ Telegram token saved${NC}"
    echo ""
fi

# Model selection
echo "Which Claude model?"
echo ""
echo "  1) Sonnet  (fast, recommended)"
echo "  2) Opus    (smartest)"
echo ""
read -rp "Choose [1-2]: " MODEL_CHOICE

case "$MODEL_CHOICE" in
    1) MODEL="sonnet" ;;
    2) MODEL="opus" ;;
    *)
        echo -e "${RED}Invalid choice${NC}"
        exit 1
        ;;
esac
echo -e "${GREEN}✓ Model: $MODEL${NC}"
echo ""

# Heartbeat interval
echo "Heartbeat interval (seconds)?"
echo -e "${YELLOW}(How often Claude checks in proactively)${NC}"
echo ""
read -rp "Interval [default: 500]: " HEARTBEAT_INPUT
HEARTBEAT_INTERVAL=${HEARTBEAT_INPUT:-500}

# Validate it's a number
if ! [[ "$HEARTBEAT_INTERVAL" =~ ^[0-9]+$ ]]; then
    echo -e "${RED}Invalid interval, using default 500${NC}"
    HEARTBEAT_INTERVAL=500
fi
echo -e "${GREEN}✓ Heartbeat interval: ${HEARTBEAT_INTERVAL}s${NC}"
echo ""

# Write settings.json
cat > "$SETTINGS_FILE" <<EOF
{
  "channel": "$CHANNEL",
  "model": "$MODEL",
  "discord_bot_token": "$DISCORD_TOKEN",
  "telegram_bot_token": "$TELEGRAM_TOKEN",
  "heartbeat_interval": $HEARTBEAT_INTERVAL
}
EOF

echo -e "${GREEN}✓ Configuration saved to .tinyclaw/settings.json${NC}"
echo ""
echo "You can now start TinyClaw:"
echo -e "  ${GREEN}./tinyclaw.sh start${NC}"
echo ""
