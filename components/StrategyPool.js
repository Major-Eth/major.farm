/******************************************************************************
**	@Author:				Thomas Bouder <Tbouder>
**	@Email:					Tbouder@protonmail.com
**	@Date:					Monday May 10th 2021
**	@Filename:				StrategyPool.js
******************************************************************************/

import	{useState, useEffect}		from	'react';
import	useCurrencies				from	'contexts/useCurrencies';
import	{toAddress, bigNumber}		from	'utils';
import	{ethers}					from	'ethers';
import	SectionRemove				from	'components/Strategies/SectionRemove'
import	SectionHead					from	'components/Strategies/SectionHead'
import	SectionFoot					from	'components/Strategies/SectionFoot'
import	Group, {GroupElement}		from	'components/Strategies/Group'
import	* as api					from	'utils/API';
import	methods						from	'utils/methodsSignatures';

async function	PrepareStrategyPool(parameters, address) {
	let		timestamp = undefined;
	const	normalTx = await api.retreiveTxFromEtherscan(address);
	const	erc20Tx = await api.retreiveErc20TxFromEtherscan(address);

	async function	computeFees() {
		const	cumulativeFees = (
			normalTx
			.filter(tx => (
				( // MIGRATE FROM V2 to V3
					toAddress(tx.from) === toAddress(address) &&
					toAddress(tx.to) === toAddress(parameters.v2Underlying) &&
					tx.input.startsWith(methods.POOL_TRANSFER)
				)
				||
				( // DEPOSIT V2
					toAddress(tx.from) === toAddress(address) &&
					toAddress(tx.to) === toAddress(parameters.v2Address) &&
					tx.input.startsWith(methods.POOL_DEPOSIT_V2)
				)
				||
				( // DEPOSIT V3
					toAddress(tx.from) === toAddress(address) &&
					toAddress(tx.to) === toAddress(parameters.contractAddress) &&
					tx.input.startsWith(methods.POOL_DEPOSIT)
				)
				||
				( // WITHDRAW
					toAddress(tx.from) === toAddress(address) &&
					toAddress(tx.to) === toAddress(parameters.contractAddress) &&
					tx.input.startsWith(methods.POOL_WITHDRAW)
				)
				||
				( // APPROVES
					tx.input.startsWith(methods.STANDARD_APPROVE) &&
					(
						(tx.input.toLowerCase()).includes((parameters.v2Address.slice(2)).toLowerCase())
						||
						(tx.input.toLowerCase()).includes((parameters.contractAddress.slice(2)).toLowerCase())
					)
				)
			)).reduce((accumulator, tx) => {
				const	gasUsed = bigNumber.from(tx.gasUsed);
				const	gasPrice = bigNumber.from(tx.gasPrice);
				const	gasUsedPrice = gasUsed.mul(gasPrice);
				return bigNumber.from(accumulator).add(gasUsedPrice);
			}, bigNumber.from(0))
		);
		return (Number(ethers.utils.formatUnits(cumulativeFees, 18)));
	}

	async function	computeSeeds() {
		const	cumulativeSeeds = (
			erc20Tx
			.filter(tx => (
				(
					toAddress(tx.to) === toAddress(parameters.contractAddress)
					&&
					tx.tokenSymbol === parameters.underlyingTokenSymbol
				)
				||
				(
					toAddress(tx.from) === toAddress(parameters.migratorAddress)
					&&
					toAddress(tx.to) === toAddress(address)
					&&
					toAddress(tx.contractAddress) === toAddress(parameters.contractAddress)
				)
			)).reduce((accumulator, tx) => {
				console.log(tx)
				if (timestamp === undefined || timestamp > tx.timeStamp) {
					timestamp = tx.timeStamp;
				}
				return bigNumber.from(accumulator).add(tx.value);
			}, bigNumber.from(0))
		);
		return Number(ethers.utils.formatUnits(cumulativeSeeds, parameters.underlyingTokenDecimal || 18));
	}

	async function	computeCrops() {
		const	provider = new ethers.providers.AlchemyProvider('homestead', process.env.ALCHEMY_KEY)
		const	ABI = ['function balanceOf(address) external view returns (uint256)']
		const	smartContract = new ethers.Contract(parameters.contractAddress, ABI, provider)
		const	balanceOf = await smartContract.balanceOf(address);
		return (Number(ethers.utils.formatUnits(balanceOf, parameters.underlyingTokenDecimal || 18)));
	}

	async function	computeHarvest() {
		const	cumulativeHarvest = (
			erc20Tx
			.filter(tx => (
				(toAddress(tx.from) === toAddress(parameters.contractAddress)) && (toAddress(tx.to) === toAddress(address))
				&&
				(tx.tokenSymbol === parameters.underlyingTokenSymbol)
			)).reduce((accumulator, tx) => {
				return bigNumber.from(accumulator).add(tx.value);
			}, bigNumber.from(0))
		);
		return Number(ethers.utils.formatUnits(cumulativeHarvest, parameters.underlyingTokenDecimal || 18));
	}


	const	fees = await computeFees();
	const	initialCrops = await computeCrops();
	const	initialSeeds = await computeSeeds();
	const	harvest = await computeHarvest();

	return {
		fees,
		initialSeeds,
		initialCrops,
		harvest,
		timestamp,
	}
}

function	StrategyPool({parameters, address, uuid, fees, initialSeeds, initialCrops, harvest, date}) {
	const	{tokenPrices, currencyNonce} = useCurrencies();

	const	[isHarvested, set_isHarvested] = useState(false);

	const	[APY, set_APY] = useState(0);
	const	[result, set_result] = useState(0);
	const	[yieldEarned, set_yieldEarned] = useState(0);
	const	[prizeEarned, set_prizeEarned] = useState(0);
	const	[totalFeesEth] = useState(fees);

	const	[ethToBaseCurrency, set_ethToBaseCurrency] = useState(tokenPrices['eth']?.price || 0);
	const	[yieldToBaseCurrency, set_yieldToBaseCurrency] = useState(tokenPrices[parameters.yieldTokenCgID]?.price || 0);
	const	[underlyingToBaseCurrency, set_underlyingToBaseCurrency] = useState(tokenPrices[parameters.underlyingTokenCgID]?.price || 0);
		
	async function	retrievePools() {
		const	provider = new ethers.providers.AlchemyProvider('homestead', process.env.ALCHEMY_KEY)
		const	ABI = ['function claim(address user) external returns (uint256)']
		const	smartContract = new ethers.Contract(parameters.yieldContractAddress, ABI, provider)
		const	claim = await smartContract.callStatic.claim(address);
		set_yieldEarned(Number(ethers.utils.formatUnits(claim, parameters.yieldTokenDecimal || 18)))
	}

	async function	retrievePrize() {
		const	provider = new ethers.providers.AlchemyProvider('homestead', process.env.ALCHEMY_KEY)
		const	ABI = ['function balanceOf(address user) external view returns (uint256)']
		const	smartContract = new ethers.Contract(parameters.contractAddress, ABI, provider)
		const	balanceOf = await smartContract.balanceOf(address);
		set_prizeEarned(Number(ethers.utils.formatUnits(balanceOf, parameters.underlyingTokenDecimal || 18)))
	}

	useEffect(() => {
		if (harvest > 0 && initialCrops === 0) {
			set_isHarvested(true);
		}
	}, [harvest, initialCrops])

	useEffect(() => {
		set_ethToBaseCurrency(tokenPrices['eth']?.price || 0);
		set_underlyingToBaseCurrency(tokenPrices[parameters.underlyingTokenCgID]?.price || 0);
		set_yieldToBaseCurrency(tokenPrices[parameters.yieldTokenCgID]?.price || 0);
		retrievePools();
		retrievePrize();
	}, [currencyNonce]);

	useEffect(() => {
		if (harvest > 0 && initialCrops === 0) {
			set_result(((harvest - initialSeeds) * underlyingToBaseCurrency) - (totalFeesEth * ethToBaseCurrency));
		} else {
			set_result(
				((yieldEarned - initialSeeds) * underlyingToBaseCurrency) -
				(totalFeesEth * ethToBaseCurrency)
			);
		}
	}, [ethToBaseCurrency, underlyingToBaseCurrency, yieldEarned, totalFeesEth])

	useEffect(() => {
		const	vi = initialSeeds * underlyingToBaseCurrency;
		const	vf = result + vi;
		set_APY((vf - vi) / vi * 100)
	}, [ethToBaseCurrency, result])

	return (
		<div className={'flex flex-col col-span-1 rounded-lg shadow bg-dark-600 p-6 relative'}>
			<SectionRemove uuid={uuid} />
			<SectionHead
				title={parameters.title}
				href={parameters.href}
				address={address}
				date={date}
				APY={APY} />
			
			<div className={'space-y-8'}>
				<Group title={'Seeds'}>
					<GroupElement
						image={parameters.underlyingTokenIcon}
						label={parameters.underlyingTokenSymbol}
						address={parameters.underlyingTokenAddress}
						amount={parseFloat(initialSeeds.toFixed(10))}
						value={(initialSeeds * underlyingToBaseCurrency).toFixed(2)} />
				</Group>

				<Group title={'Crops'}>
					<GroupElement
						image={'/pldai.png'}
						label={`pl-${parameters.underlyingTokenSymbol}`}
						address={parameters.contractAddress}
						amount={parseFloat(initialCrops.toFixed(10))}
						value={(initialCrops * underlyingToBaseCurrency).toFixed(2)} />
				</Group>

				{isHarvested ?
					<>
						<Group title={'Yield'}>
							<GroupElement
								image={'/pool.png'}
								label={`Pool`}
								address={parameters.yieldContractAddress}
								amount={parseFloat((yieldEarned).toFixed(10))}
								value={(yieldEarned * yieldToBaseCurrency).toFixed(2)} />
						</Group>
						<Group title={'Harvest'}>
							<GroupElement
								image={parameters.underlyingTokenIcon}
								label={parameters.underlyingTokenSymbol}
								address={parameters.underlyingTokenAddress}
								amount={parseFloat(harvest.toFixed(10))}
								value={(harvest * underlyingToBaseCurrency).toFixed(2)} />
							<GroupElement
								image={'⛽️'}
								label={'Fees'}
								amount={parseFloat(totalFeesEth.toFixed(10))}
								value={-(totalFeesEth * ethToBaseCurrency).toFixed(2)} />
						</Group>
					</>
				: 
					<Group title={'Yield'}>
						<GroupElement
							image={'/pool.png'}
							label={`POOL`}
							address={parameters.yieldContractAddress}
							amount={parseFloat(yieldEarned.toFixed(10))}
							value={(yieldEarned * yieldToBaseCurrency).toFixed(2)} />
						<GroupElement
							image={'/pldai.png'}
							label={`pl-${parameters.underlyingTokenSymbol} Prize`}
							address={parameters.contractAddress}
							amount={parseFloat((prizeEarned - initialCrops).toFixed(10))}
							value={((prizeEarned - initialCrops) * yieldToBaseCurrency).toFixed(2)} />
						<GroupElement
							image={'⛽️'}
							label={'Fees'}
							amount={parseFloat(totalFeesEth.toFixed(10))}
							value={-(totalFeesEth * ethToBaseCurrency).toFixed(2)} />
					</Group>
				}
			</div>

			<SectionFoot result={result} />
		</div>
	)
}

export {PrepareStrategyPool};
export default StrategyPool;